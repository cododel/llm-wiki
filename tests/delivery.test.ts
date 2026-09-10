import { test, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID, createHmac } from 'node:crypto';
import { connect, migrate } from '../src/storage/database.ts';
import { deliver } from '../src/delivery/outbox.ts';
const url=process.env.TEST_DATABASE_URL;
if(!url||!new URL(url).pathname.startsWith('/wiki_test_'))throw new Error('Disposable database required');
const db=connect(url);
beforeAll(async()=>{await migrate(db);});afterAll(async()=>{await db.close();});
test('signed delivery is independent from execution and duplicate delivery retains event ID',async()=>{
  const id=randomUUID(),secret='synthetic-webhook-secret';
  await db`INSERT INTO outbox(id,channel,payload,created_at) VALUES(${id},'review',${{version:1,job_id:randomUUID()}}::jsonb,'2000-01-01')`;
  let calls=0;
  const fetcher=Object.assign(async(_input:RequestInfo|URL,init?:RequestInit)=>{
    calls++;const headers=new Headers(init?.headers),body=String(init?.body);
    expect(headers.get('X-Wiki-Event')).toBe(id);
    expect(headers.get('X-Wiki-Signature')).toBe('sha256='+createHmac('sha256',secret).update(`${headers.get('X-Wiki-Timestamp')}.${body}`).digest('hex'));
    return new Response(null,{status:calls===1?503:204});
  },{preconnect:fetch.preconnect});
  await deliver(db,{review:{url:'https://executor.example.invalid',secret}},fetcher);
  expect((await db`SELECT state FROM outbox WHERE id=${id}`)[0].state).toBe('pending');
  await db`UPDATE outbox SET available_at=now() WHERE id=${id}`;
  await deliver(db,{review:{url:'https://executor.example.invalid',secret}},fetcher);
  expect((await db`SELECT state FROM outbox WHERE id=${id}`)[0].state).toBe('delivered');
  expect(calls).toBe(2);
});
