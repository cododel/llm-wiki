import {randomUUID} from 'node:crypto';
import {connect,migrate} from '../src/storage/database.ts';
import {CoreReader} from '../src/content/core-reads.ts';
import {applyCoreChange} from '../src/content/core-write.ts';
import type {Identity} from '../src/auth/identity.ts';
const url=process.env.TEST_DATABASE_URL;
if(!url||!new URL(url).pathname.startsWith('/wiki_test_'))throw new Error('Disposable TEST_DATABASE_URL required');
const admin=connect(url),name=`wiki_test_load_${randomUUID().replaceAll('-','')}`;
await admin.unsafe(`CREATE DATABASE ${name}`).simple();
const destination=new URL(url);destination.pathname=`/${name}`;const db=connect(destination.href);
const identity:Identity={actor:'load-test',subject:'test',client:'personal',role:'personal'};
async function measure(run:()=>Promise<unknown>) {
  await run();const values=[];
  for(let i=0;i<10;i++){const start=performance.now();await run();values.push(performance.now()-start);}
  values.sort((a,b)=>a-b);return {median_ms:Math.round(values[5]!*100)/100,p95_ms:Math.round(values[9]!*100)/100};
}
try {
  await migrate(db);let existing=0;
  const reader=new CoreReader(db,identity,{publicEnabled:true});
  for(const count of [10000,100000]) {
    const start=performance.now();
    for(let from=existing+1;from<=count;from+=5000)await db.begin(async tx=>{
      const until=Math.min(count,from+4999);
      await tx`INSERT INTO records(id,type,kind) SELECT md5('load:'||n)::uuid,'note','record' FROM generate_series(${from}::int,${until}::int) n`;
      await tx`INSERT INTO revisions(id,record_id,title,slug,body,metadata,content_hash,actor)
        SELECT md5('load:'||n||':'||v)::uuid,md5('load:'||n)::uuid,'Synthetic record '||n,'load-'||n,
          CASE WHEN n%100=0 THEN 'Rareplatypus research. Исследования знаний.' ELSE 'Synthetic knowledge with evidence and context.' END||' revision '||v,
          '{}',repeat('a',64),'load-test' FROM generate_series(${from}::int,${until}::int) n CROSS JOIN generate_series(1,3) v`;
      await tx`UPDATE revision_details SET native=true,maturity='seed' WHERE revision_id IN
        (SELECT md5('load:'||n||':'||v)::uuid FROM generate_series(${from}::int,${until}::int) n CROSS JOIN generate_series(1,3) v)`;
      await tx`INSERT INTO revision_seals SELECT md5('load:'||n||':'||v)::uuid
        FROM generate_series(${from}::int,${until}::int) n CROSS JOIN generate_series(1,3) v`;
      await tx`UPDATE records r SET current_revision=md5('load:'||n||':3')::uuid,
        published_revision=CASE WHEN n%10=0 THEN md5('load:'||n||':1')::uuid ELSE NULL END
        FROM generate_series(${from}::int,${until}::int) n WHERE r.id=md5('load:'||n)::uuid`;
    });
    await db`ANALYZE records`;await db`ANALYZE revisions`;await db`ANALYZE revision_details`;
    const fixtureMs=Math.round(performance.now()-start);
    const hits=await reader.catalog({query:'rareplatypus',mode:'strict',limit:20,offset:0});
    if(hits.items.length!==20)throw new Error('Load fixture search coverage failed');
    const stats={records:count,revisions:count*3,fixture_ms:fixtureMs,
      catalog:await measure(()=>reader.catalog({limit:20,offset:0})),
      fts:await measure(()=>reader.catalog({query:'rareplatypus',mode:'strict',limit:20,offset:0})),
      resolve:await measure(()=>reader.resolve('load-100')),
      context:await measure(()=>reader.context(hits.items.slice(0,5).map(i=>i.id))),
      create:await measure(()=>applyCoreChange(db,identity,{contract_version:3,idempotency_key:randomUUID(),operations:[{op:'create',id:randomUUID(),document:{title:'Measured write'}}]})),
    };
    console.log(`LOAD ${JSON.stringify(stats)}`);existing=count;
  }
} finally {await db.close();await admin.unsafe(`DROP DATABASE ${name}`).simple();await admin.close();}
