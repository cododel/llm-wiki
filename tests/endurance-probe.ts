import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {disposable} from './disposable.ts';
import {applyCoreChange} from '../src/content/core-write.ts';
import {CoreReader} from '../src/content/core-reads.ts';
import {createMcp} from '../src/mcp/server.ts';
import {BlobStore} from '../src/storage/blobs.ts';
import {sha256} from '../src/storage/database.ts';
import {Queue} from '../src/factcheck/queue.ts';
import {complete} from '../src/factcheck/results.ts';
import type {Identity} from '../src/auth/identity.ts';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

const fixture=await disposable('endurance'),{db}=fixture;
const root=await mkdtemp(join(tmpdir(),'wiki-endurance-blobs-'));
const actor:Identity={actor:'endurance',subject:'owner',client:'personal',role:'personal'};
const work={factcheck:true,review:true,concurrency:{factcheck:8,review:8},leaseSeconds:300,maxAttempts:3};
const blobs=new BlobStore(db,root),reader=new CoreReader(db,actor,{publicEnabled:true});
const queue=new Queue(db,work),bytes=Buffer.from('%PDF-1.7\nSynthetic endurance original'),hash=sha256(bytes);
const smoke=process.argv.includes('--smoke');
const clients:Array<{client:Client;server:ReturnType<typeof createMcp>}> = [];
const profiles:Array<{records:number;duration_ms:number;operations:number;latencies_ms:{p50:number;p95:number;max:number};samples:unknown[];status:string}> = [];
const reportDirectory=process.env.VERIFICATION_REPORT_DIR;
let interrupted=false;
let activeStart=0,activeLatencies:number[]=[];
const interrupt=()=>{interrupted=true;};process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
const save=async()=>{if(reportDirectory)await writeFile(join(reportDirectory,'endurance.json'),JSON.stringify({mode:smoke?'smoke-not-acceptance':'acceptance',transport:'in-memory MCP, actual PostgreSQL and blob store',profiles},null,2)+'\n');};
const change=(operations:unknown[],key=randomUUID())=>applyCoreChange(db,actor,{contract_version:3,idempotency_key:key,operations});
function finishMetrics(){
  const active=profiles.at(-1);if(!active||active.status!=='running'||!activeStart)return;
  activeLatencies.sort((a,b)=>a-b);active.duration_ms=Math.round(performance.now()-activeStart);
  active.latencies_ms={p50:activeLatencies[Math.floor(activeLatencies.length*.5)]??0,p95:activeLatencies[Math.floor(activeLatencies.length*.95)]??0,max:activeLatencies.at(-1)??0};
}

try{
  await blobs.ingest(actor,bytes,'application/pdf',hash);
  let existing=0;
  for(let n=0;n<8;n++){
    const server=createMcp({db,identity:{...actor,actor:`endurance-${n}`},publicationEnabled:true,work,blobs});
    const client=new Client({name:`endurance-${n}`,version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
    clients.push({client,server});await server.connect(a);await client.connect(b);
  }
  for(const count of [10000,100000]){
    for(let from=existing+1;from<=count;from+=1000){
      if(interrupted)throw new Error('Endurance interrupted');
      await db.begin(async tx=>{
        const until=Math.min(count,from+999);
        await tx`INSERT INTO records(id,type,kind) SELECT md5('endurance:'||n)::uuid,'note','record' FROM generate_series(${from}::int,${until}::int) n`;
        await tx`INSERT INTO revisions(id,record_id,title,slug,body,metadata,content_hash,actor)
          SELECT md5('endurance:'||n||':'||v)::uuid,md5('endurance:'||n)::uuid,'Research заметка '||n,'endurance-'||n,
          CASE WHEN v=1 THEN 'PUBLIC research знания ' ELSE 'PRIVATECANARY research знания ' END||repeat('context ',1+n%128),
          '{}',repeat('a',64),'endurance-fixture' FROM generate_series(${from}::int,${until}::int) n CROSS JOIN generate_series(1,3) v`;
        await tx`UPDATE revision_details SET native=true,check_policy='manual' WHERE revision_id IN
          (SELECT md5('endurance:'||n||':'||v)::uuid FROM generate_series(${from}::int,${until}::int) n CROSS JOIN generate_series(1,3) v)`;
        await tx`INSERT INTO revision_blobs(revision_id,hash) SELECT md5('endurance:'||n||':3')::uuid,${hash} FROM generate_series(${from}::int,${until}::int) n WHERE n%100=0`;
        await tx`INSERT INTO revision_seals SELECT md5('endurance:'||n||':'||v)::uuid FROM generate_series(${from}::int,${until}::int) n CROSS JOIN generate_series(1,3) v`;
        await tx`UPDATE records r SET current_revision=md5('endurance:'||n||':3')::uuid,published_revision=CASE WHEN n%10=0 THEN md5('endurance:'||n||':1')::uuid END
          FROM generate_series(${from}::int,${until}::int) n WHERE r.id=md5('endurance:'||n)::uuid`;
      });
    }
    existing=count;await db`ANALYZE`;
    const publicReader=new CoreReader(db,{actor:'public',subject:'',client:'',role:'public'},{publicEnabled:true});
    const duration=smoke?10_000:count===10000?3_600_000:120_000,start=performance.now(),latencies:number[]=[],samples:unknown[]=[];
    activeStart=start;activeLatencies=latencies;
    const profile={records:count,duration_ms:0,operations:0,latencies_ms:{p50:0,p95:0,max:0},samples,status:'running'};
    profiles.push(profile);await save();
    let nextSample=0;
    const loops=clients.map(async({client},index)=>{
      const id=randomUUID();await change([{op:'create',id,document:{title:`Client ${index}`,check_policy:'manual',attachments:[hash]}}]);
      let iteration=0;
      while(performance.now()-start<duration&&!interrupted){
        const before=await reader.record(id),key=randomUUID();
        const operations=[{op:'edit',id,expected_revision:before.revision,patch:{body:`Client ${index} iteration ${iteration} PRIVATECANARY`}}];
        const t=performance.now();
        const response=await client.callTool({name:'wiki_apply_change',arguments:{contract_version:3,idempotency_key:key,operations}});
        assert(!response.isError,'Accepted write');
        if(iteration%10===0)assert.deepEqual((await client.callTool({name:'wiki_apply_change',arguments:{contract_version:3,idempotency_key:key,operations}})).structuredContent,response.structuredContent,'Retry must replay accepted response');
        const page=await client.callTool({name:'wiki_get_page',arguments:{contract_version:3,id}});
        assert(!page.isError);assert(JSON.stringify(page.structuredContent).includes(`Client ${index} iteration ${iteration}`));
        for(const query of ['research','знания'])assert(!(await client.callTool({name:'wiki_search',arguments:{contract_version:3,query,limit:10}})).isError);
        const publicHits=await publicReader.catalog({query:'PRIVATECANARY',limit:20,offset:0});assert.equal(publicHits.items.length,0,'Private revision must not rank');
        const published=await publicReader.catalog({limit:5,offset:index*5});
        assert(!JSON.stringify(await publicReader.context(published.items.map(i=>i.id))).includes('PRIVATECANARY'));
        if(iteration%12===0){
          const campaign=await queue.reviewStart(actor,[id],randomUUID()),job=campaign.jobs[0];
          assert(typeof job==='string');const claim=await queue.claim(actor,job),snapshot=await reader.record(id);
          await queue.progress(actor,job,claim.claim_token,{stage:'synthetic',notes:'No research performed'});
          await complete(db,actor,job,claim.claim_token,{version:1,records:[{id,revision:snapshot.revision,coverage:'no_claims',reason:'Synthetic fixture',claims:[]}],suggestions:[]});
        }
        latencies.push(performance.now()-t);profile.operations++;iteration++;
        if(index===0&&performance.now()>=nextSample){
          nextSample=performance.now()+30_000;
          const [connections]=await db`SELECT count(*)::int AS connections,count(*) FILTER(WHERE wait_event_type='Lock')::int AS lock_waiters FROM pg_stat_activity WHERE datname=current_database()`;
          const states=await db`SELECT state,count(*)::int AS count FROM jobs GROUP BY state`;
          samples.push({elapsed_ms:Math.round(performance.now()-start),rss:process.memoryUsage().rss,...connections,states});
          console.log(`ENDURANCE ${count} records: ${Math.round((performance.now()-start)/1000)}s, ${profile.operations} cycles`);await save();
        }
        await Bun.sleep(smoke?10:1000);
      }
      assert.equal((await db`SELECT count(*)::int AS n FROM revisions WHERE record_id=${id}`)[0].n,iteration+1,'No lost or duplicated revisions');
    });
    const results=await Promise.allSettled(loops.map(loop=>loop.catch(error=>{interrupted=true;throw error;})));
    const failed=results.find(r=>r.status==='rejected');
    if(failed?.status==='rejected')throw failed.reason;
    assert(!interrupted,'Endurance interrupted');
    await queue.recover();
    assert.equal((await db`SELECT count(*)::int AS n FROM jobs WHERE state IN ('pending','running')`)[0].n,0,'Assignments drained');
    assert.equal((await db`SELECT count(*)::int AS n FROM revisions v LEFT JOIN revision_seals s ON s.revision_id=v.id WHERE s.revision_id IS NULL`)[0].n,0,'All accepted revisions sealed');
    assert.deepEqual(Buffer.from((await blobs.read(actor,false,hash)).bytes),bytes);
    finishMetrics();
    assert(profile.duration_ms>=duration);profile.status='passed';await save();
  }
}catch(error){finishMetrics();const active=profiles.find(p=>p.status==='running');if(active)active.status='failed';await save();throw error;}
finally{
  for(const {client,server} of clients){await client.close();await server.close();}
  await fixture.close();await rm(root,{recursive:true,force:true});
  process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);
}
