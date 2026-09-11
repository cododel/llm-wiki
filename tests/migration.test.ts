import {test,expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {readdir} from 'node:fs/promises';
import {connect,migrate,sha256} from '../src/storage/database.ts';
import {backfillCore} from '../src/storage/backfill.ts';
import {seed} from '../src/storage/seed.ts';
import {Reader} from '../src/content/reads.ts';
import {CoreReader} from '../src/content/core-reads.ts';
import {applyCoreChange} from '../src/content/core-write.ts';
import {Queue} from '../src/factcheck/queue.ts';
import type {Identity} from '../src/auth/identity.ts';
import {publicationPreview} from '../src/runtime/publication-page.ts';
const url=process.env.TEST_DATABASE_URL;
if(!url||!new URL(url).pathname.startsWith('/wiki_test_'))throw new Error('Disposable TEST_DATABASE_URL required');
const actor:Identity={actor:'migration-test',subject:'owner',client:'personal',role:'personal'};
test('v2 upgrade resumes bounded backfill and preserves history, publication, snapshots and checkpoints',async()=>{
  const admin=connect(url),name=`wiki_test_upgrade_${randomUUID().replaceAll('-','')}`;
  await admin.unsafe(`CREATE DATABASE ${name}`).simple();
  const destination=new URL(url);destination.pathname=`/${name}`;const db=connect(destination.href);
  try {
    const directory=new URL('../migrations/',import.meta.url);
    await db`CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL)`;
    for(const file of (await readdir(directory)).filter(f=>/^00[1-4]_/.test(f)).sort()) {
      const sql=await Bun.file(new URL(file,directory)).text();
      await db.begin(async tx=>{await tx.unsafe(sql).simple();await tx`INSERT INTO schema_migrations VALUES(${file},${sha256(sql)})`;});
    }
    const id=randomUUID(),versions=[randomUUID(),randomUUID(),randomUUID()],job=randomUUID(),approval=randomUUID();
    await db`INSERT INTO taxonomy VALUES('learning','Existing operator taxonomy')`;
    await db`INSERT INTO instance_state VALUES('seed-v1','true')`;
    await db.begin(async tx=>{
      await tx`INSERT INTO records(id,type) VALUES(${id},'note')`;
      for(const [i,revision] of versions.entries()) {
        await tx`INSERT INTO revisions(id,record_id,title,slug,body,metadata,content_hash,actor)
          VALUES(${revision},${id},'Legacy note','legacy-note',${`Evidence ${i}`},${{summary:'Retain legacy metadata'}}::jsonb,${sha256(`historical-${i}`)},${actor.actor})`;
        await tx`INSERT INTO revision_tags VALUES(${revision},'learning')`;
        await tx`INSERT INTO revision_seals VALUES(${revision})`;
      }
      await tx`UPDATE records SET current_revision=${versions[2]!},published_revision=${versions[0]!} WHERE id=${id}`;
      await tx`INSERT INTO publication_requests(id,record_id,revision_id,requested_by) VALUES(${approval},${id},${versions[2]!},${actor.actor})`;
    });
    const legacy=await new Reader(db,actor,{publicEnabled:false}).page(id);
    await db`INSERT INTO jobs(id,kind,target_id,revision_id,fingerprint,snapshot,state)
      VALUES(${job},'factcheck',${id},${legacy.revision},${legacy.content_hash},${legacy}::jsonb,'complete')`;
    await db`INSERT INTO checkpoints VALUES(${id},${legacy.content_hash},${job})`;
    const [before]=await db`SELECT snapshot FROM jobs WHERE id=${job}`;
    const file='005_fixed_knowledge_core.sql',sql=await Bun.file(new URL(file,directory)).text();
    await db.begin(async tx=>{await tx.unsafe(sql).simple();await tx`INSERT INTO schema_migrations VALUES(${file},${sha256(sql)})`;});
    expect(await backfillCore(db,1,1)).toEqual({batches:1,revisions:1});
    expect(await db`SELECT revision_id FROM legacy_backfill_pending`).toHaveLength(2);
    await migrate(db);await seed(db);await migrate(db);
    expect(await db`SELECT revision_id FROM legacy_backfill_pending`).toHaveLength(0);
    expect((await db`SELECT snapshot FROM jobs WHERE id=${job}`)[0].snapshot).toEqual(before.snapshot);
    expect(await db`SELECT * FROM checkpoints WHERE job_id=${job}`).toHaveLength(1);
    expect((await db`SELECT state FROM publication_requests WHERE id=${approval}`)[0].state).toBe('pending');
    expect(await new Reader(db,actor,{publicEnabled:false}).page(id)).toEqual(legacy);
    const core=new CoreReader(db,actor,{publicEnabled:false}),page=await core.record(id);
    const preview=await publicationPreview(core,id,page.revision);
    expect(preview.legacy?.metadata.summary).toBe('Retain legacy metadata');
    expect(preview.legacy).toEqual(legacy);
    expect(page.document.maturity).toBeNull();expect(page.terms.map(t=>t.name).sort()).toEqual(['learning','note']);
    expect(page.legacy_revision).toBe(legacy.revision);
    const queue=new Queue(db,{factcheck:true,review:true,concurrency:{factcheck:1,review:1},leaseSeconds:300,maxAttempts:3});
    expect(await queue.detect(actor)).toEqual({queued:0});
    await applyCoreChange(db,actor,{contract_version:3,idempotency_key:randomUUID(),operations:[{op:'edit',id,expected_revision:page.revision,patch:{maturity:'growing'}}]});
    expect((await core.record(id)).content_hash).toBe(legacy.content_hash);
    expect(await queue.detect(actor)).toEqual({queued:0});
    expect((await db`SELECT published_revision FROM records WHERE id=${id}`)[0].published_revision).toBe(versions[0]);
    expect((await db`SELECT state FROM publication_requests WHERE id=${approval}`)[0].state).toBe('stale');
    await expect((async()=>{await db`UPDATE revision_details SET maturity='evergreen' WHERE revision_id=${legacy.revision}`;})()).rejects.toThrow('immutable revision');
  } finally {
    await db.close();await admin.unsafe(`DROP DATABASE ${name}`).simple();await admin.close();
  }
});
test('fresh initialization does not seed editorial taxonomy or knowledge',async()=>{
  const admin=connect(url),name=`wiki_test_empty_${randomUUID().replaceAll('-','')}`;
  await admin.unsafe(`CREATE DATABASE ${name}`).simple();
  const destination=new URL(url);destination.pathname=`/${name}`;const db=connect(destination.href);
  try {
    await migrate(db);await seed(db);await seed(db);
    for(const table of ['records','terms','taxonomy','collections','skills'])expect(await db.unsafe(`SELECT * FROM ${table}`)).toHaveLength(0);
  } finally {await db.close();await admin.unsafe(`DROP DATABASE ${name}`).simple();await admin.close();}
});
