import {test,expect} from 'bun:test';
import {readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {disposable} from './disposable.ts';
import {migrate,sha256} from '../src/storage/database.ts';
import {backfillCore} from '../src/storage/backfill.ts';
import {typeSchema} from '../src/content/schema.ts';
import {Reader} from '../src/content/reads.ts';
import {Queue} from '../src/factcheck/queue.ts';
import type {Identity} from '../src/auth/identity.ts';

test('all legacy types, source bytes, edges and every job state survive interrupted upgrade',async()=>{
  const fixture=await disposable('corpus',false),{db}=fixture;
  const actor:Identity={actor:'upgrade-corpus',subject:'owner',client:'personal',role:'personal'};
  try{
    const directory=new URL('../migrations/',import.meta.url);
    await db`CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL)`;
    for(const file of (await readdir(directory)).filter(f=>/^00[1-4]_/.test(f)).sort()){
      const sql=await Bun.file(new URL(file,directory)).text();
      await db.begin(async tx=>{await tx.unsafe(sql).simple();await tx`INSERT INTO schema_migrations VALUES(${file},${sha256(sql)})`;});
    }
    const source=randomUUID(),sourceRevision=randomUUID(),original=Buffer.from('Legacy\r\n原文 🧪\0'),blob=sha256('legacy binary fixture');
    await db`INSERT INTO taxonomy VALUES('legacy','Legacy taxonomy')`;
    await db`INSERT INTO blobs(hash,size,media_type) VALUES(${blob},21,'application/pdf')`;
    const ids=new Map(typeSchema.options.map(type=>[type,type==='raw-source'?source:randomUUID()]));
    await db.begin(async tx=>{
      for(const [type,id] of ids)await tx`INSERT INTO records(id,type) VALUES(${id},${type})`;
      for(const [type,id] of ids){
        const revisions=[type==='raw-source'?sourceRevision:randomUUID(),randomUUID()];
        for(const [n,revision] of revisions.entries()){
          await tx`INSERT INTO revisions(id,record_id,title,slug,body,metadata,original,original_hash,content_hash,actor)
            VALUES(${revision},${id},${`Legacy ${type}`},${`legacy-${type}`},${`Revision ${n}`},${{summary:'Retain metadata',confidence:'medium',contested:true}}::jsonb,
              ${type==='raw-source'?original:null},${type==='raw-source'?sha256(original):null},${sha256(`${type}-${n}`)},${actor.actor})`;
          await tx`INSERT INTO revision_tags VALUES(${revision},'legacy')`;
          await tx`INSERT INTO revision_blobs VALUES(${revision},${blob})`;
          if(type!=='raw-source'){
            await tx`INSERT INTO relations VALUES(${revision},${source},'supports')`;
            await tx`INSERT INTO provenance(id,revision_id,source_revision) VALUES(${randomUUID()},${revision},${sourceRevision})`;
          }
          await tx`INSERT INTO revision_seals VALUES(${revision})`;
        }
        await tx`UPDATE records SET current_revision=${revisions[1]!},published_revision=${revisions[0]!} WHERE id=${id}`;
      }
    });
    const reader=new Reader(db,actor,{publicEnabled:true}),snapshots=[];
    for(const id of ids.values()){
      for(const {id:revision} of await db<{id:string}[]>`SELECT id FROM revisions WHERE record_id=${id}`)snapshots.push(await reader.page(id,revision));
    }
    let index=0;
    for(const id of ids.values()){
      const snapshot=await reader.page(id),state=['pending','running','complete','blocked','failed'][index++%5]!;
      const job=randomUUID();
      await db`INSERT INTO jobs(id,kind,target_id,revision_id,fingerprint,snapshot,state,executor,claim_token,lease_until,progress)
        VALUES(${job},'factcheck',${id},${snapshot.revision},${snapshot.content_hash},${snapshot}::jsonb,${state},'legacy-executor',${randomUUID()},now()+interval '1 hour',${{stage:'legacy progress'}}::jsonb)`;
      if(state==='complete')await db`INSERT INTO checkpoints VALUES(${id},${snapshot.content_hash},${job})`;
      await db`INSERT INTO outbox(id,channel,payload,state) VALUES(${randomUUID()},'factcheck',${{version:1,job_id:job,snapshots:[snapshot]}}::jsonb,'pending')`;
    }
    const jobs=await db`SELECT * FROM jobs ORDER BY id`,checkpoints=await db`SELECT * FROM checkpoints ORDER BY target_id`,outbox=await db`SELECT * FROM outbox ORDER BY id`;
    const migrations=await db`SELECT * FROM schema_migrations ORDER BY name`;
    const file='005_fixed_knowledge_core.sql',sql=await Bun.file(new URL(file,directory)).text();
    await db.begin(async tx=>{await tx.unsafe(sql).simple();await tx`INSERT INTO schema_migrations VALUES(${file},${sha256(sql)})`;});
    await backfillCore(db,3,1);
    expect(await db`SELECT * FROM legacy_backfill_pending`).toHaveLength(21);
    // Fail inside the next batch; partial projection and queue deletion must roll back.
    await db.unsafe(`CREATE FUNCTION abort_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'interrupted projection'; END $$;
      CREATE TRIGGER abort_projection BEFORE INSERT ON revision_details FOR EACH ROW EXECUTE FUNCTION abort_projection();`).simple();
    try{await expect(backfillCore(db,3,1)).rejects.toThrow('interrupted projection');}
    finally{await db.unsafe('DROP TRIGGER abort_projection ON revision_details; DROP FUNCTION abort_projection()').simple();}
    expect(await db`SELECT * FROM legacy_backfill_pending`).toHaveLength(21);
    await migrate(db);await migrate(db);
    for(const snapshot of snapshots)expect(await reader.page(snapshot.id,snapshot.revision)).toEqual(snapshot);
    expect(await db`SELECT * FROM jobs ORDER BY id`).toEqual(jobs);
    expect(await db`SELECT * FROM checkpoints ORDER BY target_id`).toEqual(checkpoints);
    expect(await db`SELECT * FROM outbox ORDER BY id`).toEqual(outbox);
    expect(await db`SELECT * FROM schema_migrations WHERE name<>${file} ORDER BY name`).toEqual(migrations);
    const queue=new Queue(db,{factcheck:true,review:true,concurrency:{factcheck:8,review:8},leaseSeconds:300,maxAttempts:3});
    expect(await queue.detect(actor)).toEqual({queued:0});
    await db`UPDATE schema_migrations SET checksum=${'0'.repeat(64)} WHERE name=${file}`;
    await expect(migrate(db)).rejects.toThrow('Migration checksum mismatch');
  }finally{await fixture.close();}
});
