import { test, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { connect, migrate } from '../src/storage/database.ts';
import { seed } from './legacy-seed.ts';
import { Queue } from '../src/factcheck/queue.ts';
import { complete, fail, assignmentResult } from '../src/factcheck/results.ts';
import {Reader} from '../src/content/reads.ts';
import {documentSchema} from '../src/content/schema.ts';
import type {CheckResult} from '../src/factcheck/protocol.ts';
import { campaignSummary } from '../src/factcheck/summary.ts';
import { applyChange } from '../src/content/changes.ts';
import type { Identity } from '../src/auth/identity.ts';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.startsWith('/wiki_test_')) throw new Error('Disposable TEST_DATABASE_URL required');
const db = connect(url);
const personal: Identity = { actor: 'workflow-personal', subject: 'owner', client: 'personal', role: 'personal' };
const checker: Identity = { actor: 'workflow-checker', subject: 'machine', client: 'checker', role: 'factchecker' };
const settings = { factcheck: true, review: true, concurrency: { factcheck: 10, review: 10 }, leaseSeconds: 300, maxAttempts: 3 };
const queue = new Queue(db, settings);
beforeAll(async () => { await migrate(db); await seed(db); });
afterAll(async () => { await db.close(); });
async function target(type = 'note') {
  const id = randomUUID();
  await applyChange(db, personal, { idempotency_key: randomUUID(), operations: [{ op: 'create', id, type,
    document: { title: 'Workflow target', slug: 'workflow-target', body: 'A verifiable claim.', metadata: {}, tags: [type === 'meta' ? 'meta' : type === 'adr' ? 'adr' : 'learning'], relations: [], sources: [], attachments: [] } }] });
  return id;
}
async function assignment() {
  const id = await target(); await queue.detect(personal);
  const [job] = await db<{ id: string; revision_id: string }[]>`SELECT id,revision_id FROM jobs WHERE target_id=${id} AND kind='factcheck'`;
  return { id, job: job! };
}
const result = (id: string, revision: string):CheckResult => ({ version: 1, records: [{ id, revision, coverage: 'checked', reason: '',
  claims: [{ start: 0, end: 19, quote: 'A verifiable claim.', verdict: 'unverified', reasoning: 'No authoritative evidence found.', evidence: [] }] }], suggestions: [] });

test('disabled queue cannot be polled', async () => {
  await expect(new Queue(db, { ...settings, factcheck: false }).next(personal, 'factcheck')).rejects.toMatchObject({ code: 'disabled' });
});
test('initial detection is bounded, deduplicated, excludes meta and ADR', async () => {
  const meta = await target('meta'), adr = await target('adr'), note = await target();
  await queue.detect(personal); await queue.detect(checker);
  expect((await db`SELECT id FROM jobs WHERE target_id=${meta} OR target_id=${adr}`)).toHaveLength(0);
  expect((await db`SELECT id FROM jobs WHERE target_id=${note} AND kind='factcheck'`)).toHaveLength(1);
});
test('poll and webhook receivers race for one atomic claim', async () => {
  const { job } = await assignment();
  const attempts = await Promise.allSettled([queue.claim(personal, job.id), queue.claim(checker, job.id)]);
  expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(1);
});
test('result must cover snapshot; completion is idempotent and generates nonrecursive evidence', async () => {
  const { id, job } = await assignment();
  const claim = await queue.claim(checker, job.id);
  const wrong = result(id, randomUUID());
  await expect(complete(db, checker, job.id, claim.claim_token, wrong)).rejects.toMatchObject({ code: 'invalid_coverage' });
  expect((await db`SELECT * FROM checkpoints WHERE job_id=${job.id}`)).toHaveLength(0);
  const response = await complete(db, checker, job.id, claim.claim_token, result(id, job.revision_id));
  expect(response.state).toBe('complete');
  expect(await complete(db, checker, job.id, claim.claim_token, result(id, job.revision_id))).toEqual(response);
  expect((await db`SELECT * FROM checkpoints WHERE job_id=${job.id}`)).toHaveLength(1);
  expect((await db`SELECT * FROM events WHERE job_id=${job.id} AND kind='discrepancy'`)).toHaveLength(1);
  await queue.detect(personal);
  expect((await db`SELECT j.id FROM jobs j JOIN revisions v ON v.id=j.revision_id WHERE v.generated`)).toHaveLength(0);
});
test('lease expiry denies stale completion and another executor can resume saved progress', async () => {
  const { id, job } = await assignment(), first = await queue.claim(checker, job.id);
  await queue.progress(checker, job.id, first.claim_token, { stage: 'research' });
  await db`UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=${job.id}`;
  await queue.recover();
  await db`UPDATE jobs SET available_at=now() WHERE id=${job.id}`;
  const second = await queue.claim(personal, job.id);
  await expect(complete(db, checker, job.id, first.claim_token, result(id, job.revision_id))).rejects.toMatchObject({ code: 'stale_claim' });
  expect((await queue.snapshot(personal, job.id)).progress).toEqual({ stage: 'research' });
  expect(second.claim_token).not.toBe(first.claim_token);
});
test('review uses separate campaigns and fixed revisions', async () => {
  const id = await target();
  const key = randomUUID();
  const campaign = await queue.reviewStart(personal, [id], key);
  expect(await queue.reviewStart(personal, [id], key)).toEqual(campaign);
  expect((await db`SELECT * FROM jobs WHERE target_id=${id} AND kind='review'`)).toHaveLength(1);
  const summary=await campaignSummary(db,personal,campaign.campaign_id);
  expect(summary.total).toBe(1);expect(summary.finished).toBe(false);
});

test('retry delivery waits until the assignment can be claimed',async()=>{
  const {job}=await assignment(),claim=await queue.claim(checker,job.id);
  await fail(db,checker,job.id,claim.claim_token,'Temporary upstream error',3);
  const [pending]=await db`SELECT j.available_at AS job_at,o.available_at AS delivery_at FROM jobs j JOIN outbox o ON o.payload->>'job_id'=j.id::text
    WHERE j.id=${job.id} AND o.channel='factcheck' ORDER BY o.available_at DESC LIMIT 1`;
  expect(pending.job_at.getTime()).toBe(pending.delivery_at.getTime());
  await expect(queue.claim(personal,job.id)).rejects.toMatchObject({code:'claim_conflict'});
});

test('blocked coverage is durable without a checkpoint or immediate repeat',async()=>{
  const {id,job}=await assignment(),claim=await queue.claim(checker,job.id);
  const blocked={version:1,records:[{id,revision:job.revision_id,coverage:'blocked',reason:'Source requires operator clarification',claims:[]}],suggestions:[]};
  expect((await complete(db,checker,job.id,claim.claim_token,blocked)).state).toBe('blocked');
  await queue.detect(personal);
  expect(await db`SELECT id FROM jobs WHERE target_id=${id}`).toHaveLength(1);
  expect(await db`SELECT * FROM checkpoints WHERE job_id=${job.id}`).toHaveLength(0);
});

test('edits during research are future work; status and tags alone are not',async()=>{
  const {id,job}=await assignment();
  const doc={title:'Workflow target',slug:'workflow-target',body:'A verifiable claim.',metadata:{status:'published'},tags:['thought'],relations:[],sources:[],attachments:[]};
  const edit=await applyChange(db,personal,{idempotency_key:randomUUID(),operations:[{op:'edit',id,expected_revision:job.revision_id,document:doc}]});
  await queue.detect(personal);
  expect(await db`SELECT id FROM jobs WHERE target_id=${id}`).toHaveLength(1);
  await applyChange(db,personal,{idempotency_key:randomUUID(),operations:[{op:'edit',id,expected_revision:edit.changed[0]!.revision,document:{...doc,body:'A newly revised claim.'}}]});
  await queue.detect(personal);
  expect(await db`SELECT id FROM jobs WHERE target_id=${id}`).toHaveLength(2);
  expect((await queue.snapshot(personal,job.id)).snapshots[0]!.body).toBe('A verifiable claim.');
});
test('maximum title and large valid evidence produce a readable bounded report without losing results',async()=>{
  const id=await target();
  const reader=new Reader(db,personal,{publicEnabled:false}),page=await reader.page(id);
  const {id:ignoredId,revision:ignoredRevision,type:ignoredType,created_at:ignoredDate,content_hash:ignoredHash,original_base64:ignoredOriginal,original_hash:ignoredOriginalHash,...document}=page;
  await applyChange(db,personal,{idempotency_key:randomUUID(),operations:[{op:'edit',id,expected_revision:page.revision,document:{...document,title:'T'.repeat(300)}}]});
  await queue.detect(personal);
  const [job]=await db<{id:string;revision_id:string}[]>`SELECT id,revision_id FROM jobs WHERE target_id=${id}`;
  const claim=await queue.claim(checker,job!.id),input=result(id,job!.revision_id);
  input.records[0]!.claims=Array.from({length:101},()=>({...input.records[0]!.claims[0]!,reasoning:'r'.repeat(10000)}));
  await complete(db,checker,job!.id,claim.claim_token,input);
  const full=await assignmentResult(db,personal,job!.id);
  expect(full.result).toEqual(input);
  const [report]=await db<{id:string}[]>`SELECT r.id FROM records r JOIN revisions v ON v.id=r.current_revision WHERE v.slug=${'factcheck-'+job!.id}`;
  const snapshot=await reader.page(report!.id);
  expect(snapshot.title.length).toBeLessThanOrEqual(300);
  expect(snapshot.body.length).toBeLessThan(1_000_000);
  expect(documentSchema.safeParse({title:snapshot.title,slug:snapshot.slug,body:snapshot.body,metadata:snapshot.metadata,tags:snapshot.tags,relations:snapshot.relations,sources:snapshot.sources,attachments:snapshot.attachments}).success).toBe(true);
});
test('review proposals are stored and summarized without changing target knowledge',async()=>{
  const id=await target(),before=await new Reader(db,personal,{publicEnabled:false}).page(id);
  const campaign=await queue.reviewStart(personal,[id],randomUUID()),job=campaign.jobs[0];
  const claim=await queue.claim(checker,job),input=result(id,before.revision);
  input.suggestions=[{kind:'stale',record_id:id,description:'Ask the operator to refresh this evidence'}];
  await complete(db,checker,job,claim.claim_token,input);
  expect((await campaignSummary(db,personal,campaign.campaign_id)).suggestions).toBe(1);
  expect((await campaignSummary(db,personal,campaign.campaign_id)).finished).toBe(true);
  expect((await new Reader(db,personal,{publicEnabled:false}).page(id)).revision).toBe(before.revision);
});
test('initial corpus drains in bounded passes and periodic review has an independent opt-in interval',async()=>{
  const ids=Array.from({length:105},()=>randomUUID());
  for(let index=0;index<ids.length;index+=50)await applyChange(db,personal,{idempotency_key:randomUUID(),operations:ids.slice(index,index+50).map(id=>({
    op:'create',id,type:'note',document:{title:'Baseline corpus',slug:'baseline-corpus',body:'A dated observation.',metadata:{},tags:['learning'],relations:[],sources:[],attachments:[]},
  }))});
  await queue.detect(personal);
  const [active]=await db`SELECT count(*)::int AS count FROM jobs WHERE kind='factcheck' AND state IN ('pending','running')`;
  expect(active.count).toBeLessThanOrEqual(100);
  // Simulate already completed executor work to free capacity for the remaining baseline.
  await db`UPDATE jobs SET state='complete' WHERE kind='factcheck' AND state IN ('pending','running')`;
  await queue.detect(personal);
  const covered=await db<{target_id:string}[]>`SELECT DISTINCT target_id FROM jobs WHERE kind='factcheck'`;
  const coveredIds=new Set(covered.map(row=>row.target_id));
  expect(ids.filter(id=>coveredIds.has(id)).length).toBe(ids.length);
  expect(await queue.scheduledReview(personal,0)).toEqual({started:false});
  await db`UPDATE jobs SET state='failed' WHERE kind='review' AND state IN ('pending','running')`;
  expect((await queue.scheduledReview(personal,3600)).started).toBe(true);
  expect(await queue.scheduledReview(personal,3600)).toEqual({started:false});
});
