import {test,expect,beforeAll,afterAll} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {connect,migrate,sha256} from '../src/storage/database.ts';
import {applyCoreChange} from '../src/content/core-write.ts';
import {CoreReader} from '../src/content/core-reads.ts';
import {changeTerm,changeCollection,changeLock,listTerms,listCollections} from '../src/content/organization.ts';
import {requestPublication,approvePublication} from '../src/content/publication.ts';
import {applyChange} from '../src/content/changes.ts';
import type {Identity} from '../src/auth/identity.ts';
import {Queue} from '../src/factcheck/queue.ts';
import {complete} from '../src/factcheck/results.ts';
const url=process.env.TEST_DATABASE_URL;
if(!url||!new URL(url).pathname.startsWith('/wiki_test_'))throw new Error('Disposable TEST_DATABASE_URL required');
const db=connect(url),actor:Identity={actor:'core-personal',subject:'owner',client:'personal',role:'personal'};
const owner:Identity={...actor,role:'owner'},reader=new CoreReader(db,actor,{publicEnabled:true});
const publicReader=new CoreReader(db,{actor:'public',role:'public',subject:'',client:''},{publicEnabled:true});
const change=(operations:unknown[],key=randomUUID())=>applyCoreChange(db,actor,{contract_version:3,idempotency_key:key,operations});
const create=(id:string,title='Empty inbox item')=>({op:'create',id,document:{title}});
beforeAll(()=>migrate(db));
afterAll(async()=>{
  await db`UPDATE records SET archived=true,published_revision=NULL WHERE id IN (SELECT record_id FROM revisions WHERE actor=${actor.actor})`;
  await db.close();
});

test('native records need only a title; omitted patch fields preserve values',async()=>{
  const id=randomUUID();await change([create(id)]);
  const old=await reader.record(id);
  expect(old.document).toMatchObject({body:'',topics:[],format:null,maturity:'seed'});
  await change([{op:'edit',id,expected_revision:old.revision,patch:{body:'Durable evidence',maturity:'growing'}}]);
  const updated=await reader.record(id);
  await change([{op:'edit',id,expected_revision:updated.revision,patch:{title:'Renamed'}}]);
  expect((await reader.record(id)).document).toMatchObject({title:'Renamed',body:'Durable evidence',maturity:'growing'});
  expect((await reader.record(id,old.revision)).document.body).toBe('');
});
test('native change atomicity, retries and competing revisions',async()=>{
  const id=randomUUID(),key=randomUUID(),ops=[create(id)];const first=await change(ops,key);
  expect(await change(ops,key)).toEqual(first);
  await expect(change([create(randomUUID())],key)).rejects.toMatchObject({code:'idempotency_conflict'});
  const revision=(await reader.record(id)).revision;
  const edits=await Promise.allSettled([change([{op:'edit',id,expected_revision:revision,patch:{body:'A'}}]),change([{op:'edit',id,expected_revision:revision,patch:{body:'B'}}])]);
  expect(edits.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  const missing=randomUUID();await expect(change([create(missing),{op:'create',id:randomUUID(),document:{title:'Invalid',topics:[randomUUID()]}}])).rejects.toMatchObject({code:'invalid_term'});
  expect(await db`SELECT id FROM records WHERE id=${missing}`).toHaveLength(0);
});
test('atomic source intake preserves original bytes and pins evidence revisions',async()=>{
  const source=randomUUID(),revision=randomUUID(),id=randomUUID(),original=Buffer.from('exact\r\n\0bytes\n');
  const origin={source_kind:'user-note',source_channel:'manual',capture_boundary:'complete'};
  await change([{op:'create',id,document:{title:'Interpretation',sources:[{revision}]}},{op:'source',id:source,expected_revision:null,new_revision:revision,
    document:{title:'Original'},origin,original_base64:original.toString('base64'),checksum:sha256(original)}]);
  expect((await reader.record(source)).original_base64).toBe(original.toString('base64'));
  expect((await reader.sources(source)).processed_to).toContainEqual({id,revision:(await reader.record(id)).revision});
  await change([{op:'source',id:source,expected_revision:revision,document:{title:'Correction'},origin,original_base64:'bmV3',checksum:sha256('new')}]);
  expect((await reader.record(source,revision)).original_base64).toBe(original.toString('base64'));
  expect((await reader.record(id)).document.sources).toEqual([{revision}]);
  const queue=new Queue(db,{factcheck:true,review:true,concurrency:{factcheck:1,review:1},leaseSeconds:300,maxAttempts:3});
  await expect(queue.reviewStart(actor,[source],randomUUID())).rejects.toMatchObject({code:'invalid_target'});
  await expect(change([{op:'edit',id,expected_revision:(await reader.record(id)).revision,patch:{sources:[{revision:(await reader.record(id)).revision}]}}])).rejects.toMatchObject({code:'invalid_provenance'});
});
test('classification labels are pinned; mutable registry changes cannot leak publicly',async()=>{
  const term=randomUUID(),id=randomUUID();
  await changeTerm(db,actor,{id:term,vocabulary:'topic',name:'Published topic',aliases:['Approved alias'],expected_version:null,idempotency_key:randomUUID(),archived:false});
  await change([{op:'create',id,document:{title:'Public record',topics:[term]}}]);
  const old=await reader.record(id),request=await requestPublication(db,actor,true,id,old.revision,[]);
  await approvePublication(db,owner,true,request.request_id);
  await changeTerm(db,actor,{id:term,vocabulary:'topic',name:'SECRET renamed topic',aliases:['SECRET'],expected_version:1,idempotency_key:randomUUID(),archived:false});
  expect((await publicReader.record(id)).terms[0]?.name).toBe('Published topic');
  expect(JSON.stringify(await listTerms(publicReader,'topic'))).not.toContain('SECRET');
  await change([{op:'edit',id,expected_revision:old.revision,patch:{body:'SECRET new revision'}}]);
  expect(JSON.stringify(await publicReader.record(id))).not.toContain('SECRET');
  await expect(publicReader.record(id,(await reader.record(id)).revision)).rejects.toMatchObject({code:'not_found'});
});
test('skills are instructions with pinned dependencies; locks require a separate local grant',async()=>{
  const dep=randomUUID(),id=randomUUID();await change([create(dep)]);
  const revision=(await reader.record(dep)).revision;
  await change([{op:'skill',id,expected_revision:null,document:{title:'Synthesis',body:'Read evidence first.'},skill:{description:'Synthesize evidence',use_when:'Combining records',requirements:['Read all evidence'],dependencies:[{revision,required:true}]}}]);
  const page=await reader.record(id);expect(page.kind).toBe('skill');expect(page.document.check_policy).toBe('manual');
  expect(page.skill?.dependencies).toEqual([{revision,required:true}]);
  const lock={id,expected_version:0,idempotency_key:randomUUID(),locked:true};
  await expect(changeLock(db,actor,lock)).rejects.toMatchObject({code:'forbidden'});
  await changeLock(db,{...actor,capabilities:['manage_locks']},lock);
  await expect(change([{op:'archive',id,expected_revision:page.revision}])).rejects.toMatchObject({code:'edit_locked'});
  await expect(applyCoreChange(db,{...actor,role:'factchecker'},{contract_version:3,idempotency_key:randomUUID(),operations:[create(randomUUID())]})).rejects.toMatchObject({code:'forbidden'});
  await expect((async()=>{await db`UPDATE skill_revisions SET use_when='tampered' WHERE revision_id=${page.revision}`;})()).rejects.toThrow('immutable revision');
  await expect((async()=>{await db`DELETE FROM skill_dependencies WHERE revision_id=${page.revision}`;})()).rejects.toThrow('immutable revision');
});
test('ordered collections are private and independent from record revision/fingerprint',async()=>{
  const a=randomUUID(),b=randomUUID(),id=randomUUID();await change([create(a),create(b)]);const old=await reader.record(a);
  await changeCollection(db,actor,{id,expected_version:null,idempotency_key:randomUUID(),title:'Work',members:[b,a],archived:false});
  expect((await listCollections(reader,id)).items[0]?.members.map(m=>m.id)).toEqual([b,a]);
  expect((await reader.record(a)).revision).toBe(old.revision);
  await expect(listCollections(publicReader,id)).rejects.toMatchObject({code:'forbidden'});
});
test('maturity and editorial classification do not change evidence fingerprint',async()=>{
  const id=randomUUID();await change([create(id)]);const old=await reader.record(id);
  await change([{op:'edit',id,expected_revision:old.revision,patch:{maturity:'evergreen',check_policy:'manual'}}]);
  expect((await reader.record(id)).content_hash).toBe(old.content_hash);
});
test('v2 cannot replace a native record and erase its semantics',async()=>{
  const id=randomUUID();await change([create(id)]);
  await expect(applyChange(db,actor,{idempotency_key:randomUUID(),operations:[{op:'edit',id,expected_revision:(await reader.record(id)).revision,
    document:{title:'Legacy',slug:'legacy',body:'',metadata:{},tags:['learning'],relations:[],sources:[],attachments:[]}}]})).rejects.toMatchObject({code:'unsupported_contract'});
});
test('native assignments retain their full pinned context and generate nonrecursive evidence',async()=>{
  const id=randomUUID();await change([{op:'create',id,document:{title:'Check target',body:'A factual claim.'}}]);
  const queue=new Queue(db,{factcheck:true,review:true,concurrency:{factcheck:10,review:10},leaseSeconds:300,maxAttempts:3});
  await queue.detect(actor);
  const [job]=await db<{id:string;revision_id:string}[]>`SELECT id,revision_id FROM jobs WHERE target_id=${id}`;
  expect(job).toBeDefined();const task=await queue.snapshot(actor,job!.id);
  expect(task.version).toBe(2);expect(JSON.stringify(task)).toContain('"contract_version":3');
  await change([{op:'edit',id,expected_revision:job!.revision_id,patch:{body:'A newer claim.'}}]);
  expect((await queue.snapshot(actor,job!.id)).snapshots[0]!.body).toBe('A factual claim.');
  const checker:Identity={...actor,actor:'core-checker',role:'factchecker'},claim=await queue.claim(checker,job!.id);
  const result={version:1,records:[{id,revision:job!.revision_id,coverage:'checked',reason:'',claims:[{start:0,end:16,quote:'A factual claim.',verdict:'unverified',reasoning:'No evidence',evidence:[]}]}],suggestions:[]};
  expect((await complete(db,checker,job!.id,claim.claim_token,result)).state).toBe('complete');
  expect((await complete(db,checker,job!.id,claim.claim_token,result)).state).toBe('complete');
  await queue.detect(actor);
  expect(await db`SELECT id FROM jobs WHERE target_id=${id}`).toHaveLength(2);
  expect(await db`SELECT j.id FROM jobs j JOIN revisions v ON v.id=j.revision_id WHERE v.generated`).toHaveLength(0);
  const [report]=await db`SELECT r.id FROM records r JOIN revisions v ON v.id=r.current_revision WHERE v.actor='core-checker' AND v.generated`;
  const generated=await reader.record(report.id);expect(generated.document.derivations).toEqual([{revision:job!.revision_id,kind:'derived_from'}]);
  await db`UPDATE records SET archived=true WHERE id=${report.id}`;
});
test('reverse provenance and navigation explicitly page beyond 200 links',async()=>{
  const source=randomUUID(),revision=randomUUID();
  await change([{op:'source',id:source,expected_revision:null,new_revision:revision,document:{title:'Shared source'},
    origin:{source_kind:'doc',source_channel:'manual',capture_boundary:'complete'},original_base64:'eA==',checksum:sha256('x')}]);
  for(let offset=0;offset<201;offset+=50)await change(Array.from({length:Math.min(50,201-offset)},()=>({op:'create',id:randomUUID(),
    document:{title:'Consumer',sources:[{revision}],relations:[{target:source,kind:'about'}]}})));
  const first=await reader.provenance(source);expect(first.processed_to).toHaveLength(200);expect(first.next_offset).toBe(200);
  const last=await reader.provenance(source,revision,200);expect(last.processed_to).toHaveLength(1);expect(last.next_offset).toBeNull();
  const graph=await reader.relationships(source);expect(graph.incoming_next_offset).toBe(200);
  expect((await reader.relationships(source,revision,200)).incoming).toHaveLength(1);
});
