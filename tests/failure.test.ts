import {test,expect,afterAll} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {disposable} from './disposable.ts';
import {applyCoreChange} from '../src/content/core-write.ts';
import {CoreReader} from '../src/content/core-reads.ts';
import {BlobStore} from '../src/storage/blobs.ts';
import {sha256} from '../src/storage/database.ts';
import {Queue} from '../src/factcheck/queue.ts';
import {complete} from '../src/factcheck/results.ts';
import type {Identity} from '../src/auth/identity.ts';
const fixture=await disposable('faults'),{db}=fixture;
const actor:Identity={actor:'fault-test',subject:'owner',client:'personal',role:'personal'};
const checker:Identity={actor:'checker-test',subject:'checker',client:'checker',role:'factchecker'};
const root=await mkdtemp(join(tmpdir(),'wiki-fault-blobs-'));
afterAll(async()=>{await fixture.close();await rm(root,{recursive:true,force:true});});
const change=(operations:unknown[],key=randomUUID())=>applyCoreChange(db,actor,{contract_version:3,idempotency_key:key,operations});
const reader=new CoreReader(db,actor,{publicEnabled:false});

test('database audit failure rolls back content, revisions, search and idempotency',async()=>{
  const id=randomUUID(),key=randomUUID();
  await db.unsafe(`CREATE FUNCTION test_abort_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
    CREATE TRIGGER test_abort_audit BEFORE INSERT ON audit FOR EACH ROW EXECUTE FUNCTION test_abort_audit();`).simple();
  const operations=[{op:'create',id,document:{title:'Rollbacksentinel'}}];
  try{
    await expect(change(operations,key)).rejects.toThrow('synthetic audit failure');
    expect(await db`SELECT id FROM records WHERE id=${id}`).toHaveLength(0);
    expect(await db`SELECT id FROM revisions WHERE record_id=${id}`).toHaveLength(0);
    expect(await db`SELECT key FROM idempotency WHERE key=${key}`).toHaveLength(0);
    expect((await reader.catalog({query:'Rollbacksentinel',limit:20,offset:0})).items).toHaveLength(0);
  }finally{await db.unsafe('DROP TRIGGER test_abort_audit ON audit; DROP FUNCTION test_abort_audit()').simple();}
  await change(operations,key);
  expect((await reader.record(id)).document.title).toBe('Rollbacksentinel');
});

test('terminated database connection rolls back an in-flight service write',async()=>{
  const id=randomUUID(),key=randomUUID(),lock=81972201;
  await db.unsafe(`CREATE FUNCTION pause_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${lock}); RETURN NEW; END $$;
    CREATE TRIGGER pause_audit BEFORE INSERT ON audit FOR EACH ROW EXECUTE FUNCTION pause_audit();`).simple();
  let release=()=>{};
  const released=new Promise<void>(resolve=>{release=resolve;});
  let acquired=()=>{};
  const ready=new Promise<void>(resolve=>{acquired=resolve;});
  const blocker=db.begin(async tx=>{await tx`SELECT pg_advisory_xact_lock(${lock})`;acquired();await released;});
  await ready;
  const operations=[{op:'create',id,document:{title:'Disconnected write'}}];
  const pending=change(operations,key).then(()=>({accepted:true}),()=>({accepted:false}));
  try{
    let pid:number|undefined;
    for(let n=0;n<100;n++){
      const [row]=await db<{pid:number}[]>`SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
        WHERE a.datname=current_database() AND l.locktype='advisory' AND l.objid=${lock} AND NOT l.granted`;
      if(row){pid=row.pid;break;}await Bun.sleep(20);
    }
    expect(pid).toBeDefined();if(pid===undefined)throw new Error('Service write did not reach injected barrier');
    expect((await db`SELECT pg_terminate_backend(${pid}) AS killed`)[0].killed).toBe(true);
    expect(await pending).toEqual({accepted:false});
    expect(await db`SELECT id FROM records WHERE id=${id}`).toHaveLength(0);
    expect(await db`SELECT key FROM idempotency WHERE key=${key}`).toHaveLength(0);
  }finally{release();await blocker;await pending;await db.unsafe('DROP TRIGGER pause_audit ON audit; DROP FUNCTION pause_audit()').simple();}
  await change(operations,key);
  expect((await reader.record(id)).document.title).toBe('Disconnected write');
});

test('failed blob finalization leaves no accepted metadata and retry recovers',async()=>{
  const bytes=Buffer.from('%PDF-1.7\nSynthetic fault fixture'),hash=sha256(bytes),store=new BlobStore(db,root);
  await store.initialize();
  await mkdir(join(root,hash)); // Deterministic storage failure, including when tests run as root.
  try{
    await expect(store.ingest(actor,bytes,'application/pdf',hash)).rejects.toMatchObject({code:'invalid_attachment'});
    expect(await db`SELECT hash FROM blobs WHERE hash=${hash}`).toHaveLength(0);
    expect(await readdir(join(root,'staging'))).toHaveLength(0);
  }finally{await rm(join(root,hash),{recursive:true});}
  await store.ingest(actor,bytes,'application/pdf',hash);
  expect(Buffer.from((await store.read(actor,false,hash)).bytes)).toEqual(bytes);
  await writeFile(join(root,hash),'damaged');
  await expect(store.read(actor,false,hash)).rejects.toMatchObject({code:'invalid_attachment'});
  await writeFile(join(root,hash),bytes);
  expect(await readFile(join(root,hash))).toEqual(bytes);
});

test('completion fault is atomic; stale executor cannot complete recovered work',async()=>{
  const id=randomUUID();await change([{op:'create',id,document:{title:'Claim',body:'Synthetic claim'}}]);
  const queue=new Queue(db,{factcheck:true,review:true,concurrency:{factcheck:8,review:8},leaseSeconds:300,maxAttempts:3});
  await queue.detect(actor);
  const [job]=await db<{id:string}[]>`SELECT id FROM jobs WHERE target_id=${id}`;
  expect(job).toBeDefined();const jobId=job!.id;
  const contenders=await Promise.allSettled([queue.claim(actor,jobId),queue.claim(checker,jobId)]);
  expect(contenders.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const first=contenders[0]!.status==='fulfilled'?actor:checker;
  const owned=contenders.find(r=>r.status==='fulfilled');
  if(!owned||owned.status!=='fulfilled')throw new Error('Missing claim winner');
  await queue.progress(first,jobId,owned.value.claim_token,{stage:'research',notes:'Durable intermediate result'});
  await db`UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=${jobId}`;
  await queue.recover();await queue.recover();
  expect(await db`SELECT id FROM events WHERE job_id=${jobId} AND kind='lease_expired'`).toHaveLength(1);
  await db`UPDATE jobs SET available_at=now() WHERE id=${jobId}`;
  const claim=await queue.claim(checker,jobId),snapshot=await reader.record(id);
  expect((await queue.snapshot(checker,jobId)).progress).toEqual({stage:'research',notes:'Durable intermediate result'});
  const result={version:1,records:[{id,revision:snapshot.revision,coverage:'no_claims',reason:'Synthetic fixture',claims:[]}],suggestions:[]};
  await expect(complete(db,first,jobId,owned.value.claim_token,result)).rejects.toMatchObject({code:'stale_claim'});
  await db.unsafe(`CREATE FUNCTION test_abort_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic checkpoint failure'; END $$;
    CREATE TRIGGER test_abort_checkpoint BEFORE INSERT ON checkpoints FOR EACH ROW EXECUTE FUNCTION test_abort_checkpoint();`).simple();
  const before=await db`SELECT count(*)::int AS n FROM revisions`;
  try{
    await expect(complete(db,checker,jobId,claim.claim_token,result)).rejects.toThrow('synthetic checkpoint failure');
    expect(await db`SELECT count(*)::int AS n FROM revisions`).toEqual(before);
    expect((await db`SELECT state,result FROM jobs WHERE id=${jobId}`)[0]).toMatchObject({state:'running',result:null});
    expect(await db`SELECT * FROM checkpoints WHERE job_id=${jobId}`).toHaveLength(0);
  }finally{await db.unsafe('DROP TRIGGER test_abort_checkpoint ON checkpoints; DROP FUNCTION test_abort_checkpoint()').simple();}
  await complete(db,checker,jobId,claim.claim_token,result);
  const accepted=await db`SELECT count(*)::int AS n FROM revisions`;
  await complete(db,checker,jobId,claim.claim_token,result);
  expect(await db`SELECT count(*)::int AS n FROM revisions`).toEqual(accepted);
  expect(await db`SELECT * FROM checkpoints WHERE job_id=${jobId}`).toHaveLength(1);
});
