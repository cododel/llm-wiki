import { test, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { connect, migrate } from '../src/storage/database.ts';
import { seed } from './legacy-seed.ts';
import { applyChange } from '../src/content/changes.ts';
import { Reader } from '../src/content/reads.ts';
import { approvePublication, requestPublication, unpublish } from '../src/content/publication.ts';
import { anonymous, type Identity } from '../src/auth/identity.ts';
import { queryTags } from '../src/content/tag-query.ts';
import { health,lint,visibility } from '../src/content/diagnostics.ts';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.startsWith('/wiki_test_')) throw new Error('Disposable TEST_DATABASE_URL required');
const db = connect(url);
const personal: Identity = { actor: 'test-publisher', subject: 'owner', client: 'personal', role: 'personal' };
const owner: Identity = { actor: 'test-owner-browser', subject: 'owner', client: 'browser', role: 'owner' };
const publicReader = new Reader(db, anonymous, { publicEnabled: true });
beforeAll(async () => { await migrate(db); await seed(db); });
afterAll(async () => { await db.close(); });
const document = (body: string) => ({ title: body, slug: 'publication-test', body, metadata: { status: 'published' }, tags: ['learning'], relations: [], sources: [], attachments: [] });
async function make() {
  const id = randomUUID();
  await applyChange(db, personal, { idempotency_key: randomUUID(), operations: [{ op: 'create', id, type: 'note', document: document('Public old text') }] });
  const [record] = await db`SELECT current_revision FROM records WHERE id=${id}`;
  return { id, revision: String(record.current_revision) };
}
test('publication is explicit; only browser owner can approve', async () => {
  const { id, revision } = await make();
  await expect(publicReader.page(id)).rejects.toMatchObject({ code: 'not_found' });
  await expect(requestPublication(db, personal, false, id, revision, [])).rejects.toMatchObject({ code: 'disabled' });
  const requested = await requestPublication(db, personal, true, id, revision, []);
  await expect(approvePublication(db, personal, true, requested.request_id)).rejects.toMatchObject({ code: 'forbidden' });
  await approvePublication(db, owner, true, requested.request_id);
  expect((await publicReader.page(id)).revision).toBe(revision);
});
test('new private revision cannot leak through catalog, resolve, page or history', async () => {
  const { id, revision } = await make();
  const requested = await requestPublication(db, personal, true, id, revision, []);
  await approvePublication(db, owner, true, requested.request_id);
  await applyChange(db, personal, { idempotency_key: randomUUID(), operations: [{ op: 'edit', id, expected_revision: revision, document: document('PrivateSecretNewText') }] });
  const [updated] = await db`SELECT current_revision FROM records WHERE id=${id}`;
  expect((await publicReader.page(id)).body).toBe('Public old text');
  expect((await publicReader.resolve('PrivateSecretNewText')).candidates).toHaveLength(0);
  expect(JSON.stringify(await publicReader.list({ limit: 100, offset: 0 }))).not.toContain('PrivateSecretNewText');
  await expect(publicReader.page(id, updated.current_revision)).rejects.toMatchObject({ code: 'not_found' });
  await unpublish(db, personal, id);
  await expect(publicReader.page(id)).rejects.toMatchObject({ code: 'not_found' });
});
test('editing invalidates an outstanding approval', async () => {
  const { id, revision } = await make();
  const requested = await requestPublication(db, personal, true, id, revision, []);
  await applyChange(db, personal, { idempotency_key: randomUUID(), operations: [{ op: 'edit', id, expected_revision: revision, document: document('New revision') }] });
  await expect(approvePublication(db, owner, true, requested.request_id)).rejects.toMatchObject({ code: 'stale_approval' });
});
test('private duplicate names, tags, relations and provenance do not leak through public queries',async()=>{
  const hidden=randomUUID(),visible=randomUUID(),source=randomUUID();
  const {sha256}=await import('../src/storage/database.ts');
  const bytes=Buffer.from('Private original');
  const raw=await applyChange(db,personal,{idempotency_key:randomUUID(),operations:[{op:'source',id:source,expected_revision:null,
    document:{...document('Private raw'),tags:['source'],metadata:{source_kind:'user-note',source_channel:'manual',capture_boundary:'complete'}},
    original_base64:bytes.toString('base64'),checksum:sha256(bytes)}]});
  const revisions=await applyChange(db,personal,{idempotency_key:randomUUID(),operations:[
    {op:'tag',tag:'private-taxonomy',description:'Private classification'},
    {op:'create',id:hidden,type:'note',document:{...document('Duplicate name'),tags:['learning','private-taxonomy']}},
    {op:'create',id:visible,type:'note',document:{...document('Duplicate name'),relations:[{target:hidden,kind:'related'}],sources:[{revision:raw.changed[0].revision}]}},
  ]});
  const request=await requestPublication(db,personal,true,visible,revisions.changed[1].revision,[]);
  await approvePublication(db,owner,true,request.request_id);
  const resolved=await publicReader.resolve('Duplicate name');
  expect(resolved.status).toBe('resolved');expect(resolved.candidates[0]!.id).toBe(visible);
  expect((await new Reader(db,personal,{publicEnabled:true}).resolve('Duplicate name')).status).toBe('ambiguous');
  expect((await publicReader.page(visible)).relations).toHaveLength(0);
  expect((await publicReader.sources(visible)).sources).toHaveLength(0);
  expect(JSON.stringify(await queryTags(publicReader,'counts'))).not.toContain('private-taxonomy');
  await applyChange(db,personal,{idempotency_key:randomUUID(),operations:[{op:'tag',tag:'learning',description:'PRIVATE_MUTABLE_DESCRIPTION'}]});
  expect(JSON.stringify(await queryTags(publicReader,'counts'))).not.toContain('PRIVATE_MUTABLE_DESCRIPTION');
  expect(JSON.stringify(await queryTags(new Reader(db,personal,{publicEnabled:true}),'show','learning'))).toContain('PRIVATE_MUTABLE_DESCRIPTION');
  for(const diagnostic of [health,lint,visibility])expect(JSON.stringify(await diagnostic(publicReader))).not.toContain(hidden);
  await expect(publicReader.page(source)).rejects.toMatchObject({code:'not_found'});
});
