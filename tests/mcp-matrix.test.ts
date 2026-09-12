import {test,expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {disposable} from './disposable.ts';
import {createMcp} from '../src/mcp/server.ts';
import {BlobStore} from '../src/storage/blobs.ts';
import {applyCoreChange} from '../src/content/core-write.ts';
import {CoreReader} from '../src/content/core-reads.ts';
import {approvePublication,requestPublication} from '../src/content/publication.ts';
import {changeLock} from '../src/content/organization.ts';
import {Queue,emitEvent} from '../src/factcheck/queue.ts';
import {sha256} from '../src/storage/database.ts';
import type {Identity} from '../src/auth/identity.ts';

const actor:Identity={actor:'matrix-personal',subject:'owner',client:'personal',role:'personal'};
const work={factcheck:true,review:true,concurrency:{factcheck:100,review:100},leaseSeconds:300,maxAttempts:3};
const personalOnly=new Set(['wiki_apply_change','wiki_ingest_attachment','wiki_request_publication','wiki_unpublish','wiki_review_start','wiki_events_list','wiki_event_acknowledge','wiki_event_resolve','wiki_term_change','wiki_collection_change']);
const executors=new Set(['wiki_factcheck_next','wiki_review_next','wiki_assignment_get','wiki_assignment_result','wiki_review_summary','wiki_assignment_claim','wiki_assignment_progress','wiki_assignment_complete','wiki_assignment_fail']);

for(const role of ['public','personal','factchecker','owner'] as const)test(`MCP inventory allow/deny and non-mutation matrix: ${role}`,async()=>{
  const fixture=await disposable('matrix'),{db}=fixture,root=await mkdtemp(join(tmpdir(),'wiki-matrix-'));
  const identity:Identity={...actor,actor:`matrix-${role}`,role},blobs=new BlobStore(db,root);
  const server=createMcp({db,identity,publicationEnabled:true,work,blobs}),client=new Client({name:'matrix',version:'1'});
  try{
    const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
    const reader=new CoreReader(db,actor,{publicEnabled:true});
    const change=(operations:unknown[])=>applyCoreChange(db,actor,{contract_version:3,idempotency_key:randomUUID(),operations});
    const id=randomUUID(),skill=randomUUID(),source=randomUUID(),sourceRevision=randomUUID();
    const hiddenBytes=Buffer.from('%PDF-1.7\nPRIVATECANARY hidden attachment'),hiddenHash=sha256(hiddenBytes);
    await blobs.ingest(actor,hiddenBytes,'application/pdf',hiddenHash);
    await change([{op:'source',id:source,new_revision:sourceRevision,expected_revision:null,document:{title:'PRIVATECANARY source'},
      origin:{source_kind:'doc',source_channel:'file',capture_boundary:'complete'},original_base64:'cHJpdmF0ZQ==',checksum:sha256('private')},
      {op:'create',id,document:{title:'Public research',body:'Published research знания',check_policy:'manual',attachments:[hiddenHash],sources:[{revision:sourceRevision}],relations:[{target:source,kind:'about'}],derivations:[{revision:sourceRevision,kind:'derived_from'}]}},
      {op:'skill',id:skill,expected_revision:null,document:{title:'Published skill',body:'Read the pinned evidence.'},skill:{description:'Read',use_when:'Testing',dependencies:[{revision:sourceRevision,required:true}]}}]);
    const owner:Identity={...actor,role:'owner'},old=await reader.record(id);
    for(const record of [id,skill]){const p=await reader.record(record);const r=await requestPublication(db,actor,true,record,p.revision,[]);await approvePublication(db,owner,true,r.request_id);}
    await change([{op:'edit',id,expected_revision:old.revision,patch:{body:'PRIVATECANARY distinct new revision'}}]);
    const current=await reader.record(id);
    const queue=new Queue(db,work),campaign=await queue.reviewStart(actor,[id],randomUUID());
    const executor=role==='personal'||role==='factchecker'?identity:actor;
    const jobs=[];
    for(let n=0;n<3;n++){const c=await queue.reviewStart(actor,[id],randomUUID());const job=c.jobs[0];const claim=await queue.claim(executor,job);jobs.push({job,token:claim.claim_token});}
    await db.begin(tx=>emitEvent(tx,null,'synthetic',{note:'PRIVATECANARY event'}));
    const [event]=await db<{id:string}[]>`SELECT id FROM events LIMIT 1`;
    const pdf=Buffer.from('%PDF-1.7\nMatrix original');
    const argumentsByName:Record<string,Record<string,unknown>>={
      wiki_describe:{},wiki_get_page:{id},wiki_list:{},wiki_resolve:{name:id},wiki_search:{query:'research'},wiki_search_and_read:{query:'research'},
      wiki_regex_search:{pattern:'research|PRIVATECANARY'},wiki_get_related:{id},wiki_get_sources:{id},wiki_tags:{mode:'counts'},
      wiki_health_summary:{},wiki_lint_summary:{},wiki_audit_visibility:{},wiki_context:{ids:[id]},wiki_skills_list:{},wiki_skill_get:{id:skill},
      wiki_terms_list:{vocabulary:'topic'},wiki_collections_list:{},
      wiki_apply_change:{idempotency_key:randomUUID(),operations:[{op:'create',id:randomUUID(),document:{title:'Allowed native write'}}]},
      wiki_ingest_attachment:{original_base64:pdf.toString('base64'),checksum:sha256(pdf),media_type:'application/pdf'},
      wiki_request_publication:{id,revision:current.revision,attachments:[]},wiki_unpublish:{id},
      wiki_review_start:{ids:[id],idempotency_key:randomUUID()},wiki_factcheck_next:{},wiki_review_next:{},
      wiki_assignment_get:{job_id:campaign.jobs[0]},wiki_assignment_result:{job_id:campaign.jobs[0]},wiki_review_summary:{campaign_id:campaign.campaign_id},
      wiki_assignment_claim:{job_id:campaign.jobs[0]},
      wiki_assignment_progress:{job_id:jobs[0]!.job,claim_token:jobs[0]!.token,progress:{stage:'test',notes:'PRIVATECANARY progress'}},
      wiki_assignment_complete:{job_id:jobs[1]!.job,claim_token:jobs[1]!.token,result:{version:1,records:[{id,revision:current.revision,coverage:'no_claims',reason:'Synthetic',claims:[]}],suggestions:[]}},
      wiki_assignment_fail:{job_id:jobs[2]!.job,claim_token:jobs[2]!.token,reason:'Synthetic failure'},
      wiki_events_list:{},wiki_event_acknowledge:{id:event!.id},wiki_event_resolve:{id:event!.id,resolution:'Synthetic resolution'},
      wiki_term_change:{id:randomUUID(),vocabulary:'topic',name:'Synthetic',aliases:[],expected_version:null,idempotency_key:randomUUID(),archived:false},
      wiki_collection_change:{id:randomUUID(),title:'Synthetic',members:[id],expected_version:null,idempotency_key:randomUUID(),archived:false},
      wiki_lock_change:{id,locked:true,expected_version:0,idempotency_key:randomUUID()},
    };
    const names=(await client.listTools()).tools.map(t=>t.name);
    expect(names.sort()).toEqual(Object.keys(argumentsByName).sort());
    const tables=await db<{tablename:string}[]>`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
    const fingerprint=async()=>{
      const values=[];
      for(const {tablename} of tables){if(!/^[a-z_]+$/.test(tablename))throw new Error('Invalid test table');
        values.push(await db.unsafe(`SELECT md5(string_agg(row_to_json(r)::text,'' ORDER BY row_to_json(r)::text)) AS hash FROM ${tablename} r`));}
      return values;
    };
    // Read surfaces run before mutators so publication withdrawal cannot obscure leaks.
    const sorted=names.sort((a,b)=>Number(personalOnly.has(a)||executors.has(a))-Number(personalOnly.has(b)||executors.has(b)));
    for(const name of sorted){
      const allowed=name==='wiki_tags'||name==='wiki_lock_change'?false:
        personalOnly.has(name)?role==='personal':executors.has(name)?['personal','factchecker'].includes(role):name==='wiki_collections_list'?role!=='public':true;
      const before=allowed?null:await fingerprint();
      const response=await client.callTool({name,arguments:{...argumentsByName[name],contract_version:3}});
      expect(response.isError===true,`${role} ${name}`).toBe(!allowed);
      if(!allowed){
        expect(JSON.stringify(response.structuredContent)).toContain(name==='wiki_tags'?'unsupported_contract':'forbidden');
        expect(before).not.toBeNull();
        expect(await fingerprint()).toEqual(before??[]);
      }
      if(role==='public')for(const hidden of ['PRIVATECANARY',source,sourceRevision,hiddenHash])expect(JSON.stringify(response)).not.toContain(hidden);
    }
    // Explicit revision access and locks are independent of publication and catalog visibility.
    if(role==='personal'){
      const request=await requestPublication(db,actor,true,id,current.revision,[]);
      await approvePublication(db,owner,true,request.request_id);
      expect((await new CoreReader(db,{actor:'public',subject:'',client:'',role:'public'},{publicEnabled:true}).record(id)).revision).toBe(current.revision);
    }
    await changeLock(db,{...actor,capabilities:['manage_locks']},{id,locked:true,expected_version:0,idempotency_key:randomUUID()});
    if(role==='personal'){
      for(const operation of [{op:'edit',id,expected_revision:current.revision,patch:{body:'Must not change'}},{op:'archive',id,expected_revision:current.revision}]){
        const before=await fingerprint();
        const denied=await client.callTool({name:'wiki_apply_change',arguments:{contract_version:3,idempotency_key:randomUUID(),operations:[operation]}});
        expect(JSON.stringify(denied)).toContain('edit_locked');expect(await fingerprint()).toEqual(before);
      }
      expect((await client.callTool({name:'wiki_unpublish',arguments:{id}})).isError).not.toBe(true);
      await expect(new CoreReader(db,{actor:'public',subject:'',client:'',role:'public'},{publicEnabled:true}).record(id)).rejects.toMatchObject({code:'not_found'});
      const managerServer=createMcp({db,identity:{...identity,capabilities:['manage_locks']},publicationEnabled:true,work,blobs});
      const managerClient=new Client({name:'lock-manager',version:'1'}),[x,y]=InMemoryTransport.createLinkedPair();
      try{
        await managerServer.connect(x);await managerClient.connect(y);
        expect((await managerClient.callTool({name:'wiki_lock_change',arguments:{id,locked:false,expected_version:1,idempotency_key:randomUUID()}})).isError).not.toBe(true);
        expect((await reader.record(id)).edit_locked).toBe(false);
        expect((await managerClient.callTool({name:'wiki_lock_change',arguments:{id,locked:true,expected_version:2,idempotency_key:randomUUID()}})).isError).not.toBe(true);
        expect((await reader.record(id)).edit_locked).toBe(true);
      }finally{await managerClient.close();await managerServer.close();}
    }
    for(const archived of [false,true]){
      await db`UPDATE records SET archived=${archived},published_revision=${old.revision} WHERE id=${id}`;
      for(const revision of [undefined,old.revision,current.revision]){
        const response=await client.callTool({name:'wiki_get_page',arguments:{contract_version:3,id,revision}});
        const allowed=role!=='public'||(!archived&&revision!==current.revision);
        expect(response.isError===true).toBe(!allowed);
        if(role==='public')expect(JSON.stringify(response)).not.toContain('PRIVATECANARY');
        if(!allowed)expect(JSON.stringify(response)).toContain('not_found');
      }
    }
  }finally{await client.close();await server.close();await fixture.close();await rm(root,{recursive:true,force:true});}
});
