import {test,expect} from 'bun:test';
import {randomUUID,createHmac} from 'node:crypto';
import {disposable} from './disposable.ts';
import {applyCoreChange} from '../src/content/core-write.ts';
import {Queue} from '../src/factcheck/queue.ts';
import {deliver} from '../src/delivery/outbox.ts';
import type {Identity} from '../src/auth/identity.ts';

test('real webhook and polling share claim; lost delivery checkpoint replays one event',async()=>{
  const fixture=await disposable('delivery'),{db}=fixture;
  const personal:Identity={actor:'polling',subject:'owner',client:'personal',role:'personal'};
  const webhook:Identity={actor:'webhook',subject:'checker',client:'checker',role:'factchecker'};
  const queue=new Queue(db,{factcheck:true,review:true,concurrency:{factcheck:8,review:8},leaseSeconds:300,maxAttempts:3});
  const secret='synthetic-local-receiver',seen=new Map<string,string>(),claims:Array<PromiseSettledResult<unknown>>=[];
  let deliveries=0;
  const receiver=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    const body=await request.text(),id=request.headers.get('X-Wiki-Event')!,timestamp=request.headers.get('X-Wiki-Timestamp')!;
    expect(request.headers.get('X-Wiki-Signature')).toBe('sha256='+createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex'));
    expect(Math.abs(Date.now()/1000-Number(timestamp))).toBeLessThan(30);
    const payload=JSON.parse(body);expect(payload.event_id).toBe(id);deliveries++;
    const previous=seen.get(id);
    if(previous!==undefined)expect(body).toBe(previous);
    else{
      seen.set(id,body);
      // Start both contenders only after a real HTTP delivery reached the receiver.
      const polled=await queue.next(personal,'review');expect(polled?.job_id).toBe(payload.job_id);
      claims.push(...await Promise.allSettled([queue.claim(webhook,payload.job_id),queue.claim(personal,payload.job_id)]));
    }
    return new Response(null,{status:204});
  }});
  try{
    const id=randomUUID();await applyCoreChange(db,personal,{contract_version:3,idempotency_key:randomUUID(),operations:[{op:'create',id,document:{title:'Delivery fixture',check_policy:'manual'}}]});
    const campaign=await queue.reviewStart(personal,[id],randomUUID()),job=campaign.jobs[0];
    await db.unsafe(`CREATE FUNCTION abort_delivery_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'lost delivery checkpoint'; END $$;
      CREATE TRIGGER abort_delivery_ack BEFORE UPDATE ON outbox FOR EACH ROW WHEN (NEW.state='delivered') EXECUTE FUNCTION abort_delivery_ack();`).simple();
    const destinations={review:{url:`http://127.0.0.1:${receiver.port}/webhook`,secret}};
    try{await expect(deliver(db,destinations)).rejects.toThrow('lost delivery checkpoint');}
    finally{await db.unsafe('DROP TRIGGER abort_delivery_ack ON outbox; DROP FUNCTION abort_delivery_ack()').simple();}
    expect(claims.filter(c=>c.status==='fulfilled')).toHaveLength(1);
    expect(claims.filter(c=>c.status==='rejected')).toHaveLength(1);
    expect((await db`SELECT state FROM jobs WHERE id=${job}`)[0].state).toBe('running');
    await db`UPDATE outbox SET lease_until=now()-interval '1 second' WHERE channel='review'`;
    await deliver(db,destinations);
    expect(deliveries).toBe(2);expect(seen.size).toBe(1);
    expect((await db`SELECT state FROM outbox WHERE channel='review'`)[0].state).toBe('delivered');
    expect((await db`SELECT state FROM jobs WHERE id=${job}`)[0].state).toBe('running');
    expect(await db`SELECT * FROM checkpoints`).toHaveLength(0);
  }finally{await receiver.stop(true);await fixture.close();}
});
