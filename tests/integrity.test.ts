import {test,expect,afterAll} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {disposable} from './disposable.ts';
import {applyCoreChange} from '../src/content/core-write.ts';
import {CoreReader} from '../src/content/core-reads.ts';
import {changeCollection,changeTerm,listCollections} from '../src/content/organization.ts';
import {sha256} from '../src/storage/database.ts';
import type {Identity} from '../src/auth/identity.ts';
const fixture=await disposable('integrity'),{db}=fixture;
const actor:Identity={actor:'integrity',subject:'owner',client:'personal',role:'personal'};
const reader=new CoreReader(db,actor,{publicEnabled:false});
const change=(operations:unknown[],key=randomUUID())=>applyCoreChange(db,actor,{contract_version:3,idempotency_key:key,operations});
const origin={source_kind:'doc',source_channel:'file',capture_boundary:'complete'};
afterAll(fixture.close);

test('source byte corpus roundtrips independently including exact intake limit',async()=>{
  const originals=[Buffer.from('Русский e\u0301 é 🧪\r\n\t  code `x`\n\0\xff'),Buffer.from(' \r\n\r\n'),Buffer.alloc(1_000_000,0x61)];
  for(const original of originals){
    const id=randomUUID(),revision=randomUUID();
    await change([{op:'source',id,expected_revision:null,new_revision:revision,document:{title:'Original'},origin,original_base64:original.toString('base64'),checksum:sha256(original)}]);
    const saved=await reader.record(id);
    expect(Buffer.from(saved.original_base64!,'base64')).toEqual(original);
    expect(saved.original_hash).toBe(sha256(original));
    await change([{op:'source',id,expected_revision:revision,document:{title:'New original'},origin,original_base64:'eA==',checksum:sha256('x')}]);
    expect(Buffer.from((await reader.record(id,revision)).original_base64!,'base64')).toEqual(original);
  }
  const id=randomUUID(),large=Buffer.alloc(1_000_001,0x61);
  await expect(change([{op:'source',id,expected_revision:null,document:{title:'Too large'},origin,original_base64:large.toString('base64'),checksum:sha256(large)}])).rejects.toMatchObject({code:'invalid_source'});
  expect(await db`SELECT id FROM records WHERE id=${id}`).toHaveLength(0);
});

test('partial edits preserve organization and edges; restore creates a new revision',async()=>{
  const id=randomUUID(),source=randomUUID(),revision=randomUUID(),topic=randomUUID(),collection=randomUUID();
  await changeTerm(db,actor,{id:topic,vocabulary:'topic',name:'Evidence',aliases:[],expected_version:null,idempotency_key:randomUUID(),archived:false});
  await change([{op:'source',id:source,new_revision:revision,expected_revision:null,document:{title:'Original'},origin,original_base64:'eA==',checksum:sha256('x')},
    {op:'create',id,document:{title:'Note',body:'First content',topics:[topic],sources:[{revision}],relations:[{target:source,kind:'about'}]}}]);
  await changeCollection(db,actor,{id:collection,expected_version:null,idempotency_key:randomUUID(),title:'Reading',members:[id,source],archived:false});
  const first=await reader.record(id),navigation=await listCollections(reader,collection);
  await change([{op:'edit',id,expected_revision:first.revision,patch:{body:'Second content'}}]);
  const second=await reader.record(id);
  expect(second.document).toEqual({...first.document,body:'Second content'});
  expect(await listCollections(reader,collection)).toEqual(navigation);
  await change([{op:'edit',id,expected_revision:second.revision,patch:{body:first.document.body}}]);
  const restored=await reader.record(id);
  expect(restored.revision).not.toBe(first.revision);
  expect(restored.document).toEqual(first.document);
  expect(await reader.record(id,first.revision)).toEqual(first);
  expect(await reader.record(id,second.revision)).toEqual(second);
});

test('seeded operation sequence preserves snapshots and rolls back invalid groups',async()=>{
  let seed=0x5eed;const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  const id=randomUUID();await change([{op:'create',id,document:{title:'State machine'}}]);
  const history=[await reader.record(id)];
  for(let i=0;i<40;i++){
    const old=history.at(-1)!;
    if((next()>>>16)%4===0){
      const key=randomUUID(),missing=randomUUID();
      await expect(change([{op:'edit',id,expected_revision:old.revision,patch:{body:'Must rollback'}},{op:'create',id:missing,document:{title:'Invalid edge',relations:[{target:randomUUID(),kind:'related'}]}}],key)).rejects.toThrow();
      expect(await reader.record(id)).toEqual(old);
      expect(await db`SELECT * FROM idempotency WHERE actor=${actor.actor} AND key=${key}`).toHaveLength(0);
      expect(await db`SELECT id FROM records WHERE id=${missing}`).toHaveLength(0);
    }else{
      const key=randomUUID(),ops=[{op:'edit',id,expected_revision:old.revision,patch:{body:`Seeded value ${next()}`}}];
      const response=await change(ops,key); // Simulate a client losing this successful response.
      expect(await change(ops,key)).toEqual(response);
      history.push(await reader.record(id));
    }
  }
  expect(await db`SELECT id FROM revisions WHERE record_id=${id}`).toHaveLength(history.length);
  for(const snapshot of history)expect(await reader.record(id,snapshot.revision)).toEqual(snapshot);
  const revision=history.at(-1)!.revision;
  const race=await Promise.allSettled(Array.from({length:8},(_,i)=>change([{op:'edit',id,expected_revision:revision,patch:{body:`Concurrent ${i}`}}])));
  expect(race.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  for(const result of race)if(result.status==='rejected')expect(result.reason).toMatchObject({code:'revision_conflict'});
});

test('large context explicitly continues without truncating an original or substituting a revision',async()=>{
  const ids=[randomUUID(),randomUUID(),randomUUID()];
  await change(ids.map((id,i)=>({op:'create',id,document:{title:'Ambiguous context title',body:`Record ${i}: `+'原文 '.repeat(1000)}})));
  const snapshots=await Promise.all(ids.map(id=>reader.record(id)));
  expect((await reader.resolve('Ambiguous context title')).status).toBe('ambiguous');
  const bounded=await reader.context(ids,1000);
  expect(bounded.truncated).toBe(true);expect(bounded.remaining_ids).toEqual(ids);expect(bounded.records).toHaveLength(0);
  expect(bounded.next_action).toContain('wiki_get_page');
  await change([{op:'edit',id:ids[0]!,expected_revision:snapshots[0]!.revision,patch:{body:'A later revision'}}]);
  const pinned=new Map(snapshots.map(snapshot=>[snapshot.id,snapshot.revision]));
  const full=await reader.context(ids,100000,pinned);
  expect(full.truncated).toBe(false);expect(full.records).toEqual(snapshots);
  const pages=[];let offset=0;
  do{const page=await reader.catalog({query:'Ambiguous context title',limit:1,offset});pages.push(...page.items.map(item=>item.id));
    if(page.next_offset===null)break;offset=page.next_offset;
  }while(offset<10);
  expect(pages.sort()).toEqual([...ids].sort());
});

test('lost HTTP success response can be retried without a duplicate accepted write',async()=>{
  const id=randomUUID(),key=randomUUID(),operations=[{op:'create',id,document:{title:'Lost response fixture'}}];
  let first=true;
  const gateway=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(){
    const accepted=await change(operations,key);
    // An intermediary drops the successful application response after commit.
    if(first){first=false;return new Response('Synthetic gateway failure',{status:502});}
    return Response.json(accepted);
  }});
  try{
    expect((await fetch(`http://127.0.0.1:${gateway.port}`)).status).toBe(502);
    const snapshot=await reader.record(id);
    const retry=await fetch(`http://127.0.0.1:${gateway.port}`);
    expect(retry.status).toBe(200);expect(await retry.json()).toMatchObject({changed:[{id,revision:snapshot.revision}]});
    expect(await db`SELECT id FROM revisions WHERE record_id=${id}`).toHaveLength(1);
    expect(await db`SELECT key FROM idempotency WHERE actor=${actor.actor} AND key=${key}`).toHaveLength(1);
  }finally{await gateway.stop(true);}
});
