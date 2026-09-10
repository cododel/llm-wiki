import { test, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { connect, migrate, sha256 } from '../src/storage/database.ts';
import { seed } from '../src/storage/seed.ts';
import { applyChange } from '../src/content/changes.ts';
import { type Document } from '../src/content/schema.ts';
import type { Identity } from '../src/auth/identity.ts';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.startsWith('/wiki_test_')) throw new Error('Disposable TEST_DATABASE_URL required');
const db = connect(url);
const actor: Identity = { actor: 'test-personal', subject: 'test', client: 'test-personal', role: 'personal' };
const doc = (body = 'Evidence'): Document => ({ title: 'Test knowledge', slug: 'test-knowledge', body, metadata: {}, tags: ['learning'], relations: [], sources: [], attachments: [] });
const create = (id: string, document = doc()) => ({ op: 'create', id, type: 'note', document });
const change = (operations: unknown[], key = randomUUID()) => applyChange(db, actor, { idempotency_key: key, operations });

beforeAll(async () => { await migrate(db); await seed(db); });
afterAll(async () => { await db.close(); });

test('migrations and seed are repeatable without overwriting data', async () => {
  await migrate(db); await seed(db);
  expect((await db`SELECT tag FROM taxonomy WHERE tag='source'`).length).toBe(1);
});
test('logical group rolls back every record on invalid tags', async () => {
  const id = randomUUID();
  await expect(change([create(id), create(randomUUID(), { ...doc(), tags: ['learning','unknown'] })])).rejects.toMatchObject({ code: 'unknown_tag' });
  expect((await db`SELECT id FROM records WHERE id=${id}`).length).toBe(0);
});
test('idempotency replays identical request and rejects reuse for another request', async () => {
  const key = randomUUID(), op = create(randomUUID());
  const first = await change([op], key);
  expect(await change([op], key)).toEqual(first);
  await expect(change([create(randomUUID())], key)).rejects.toMatchObject({ code: 'idempotency_conflict' });
});
test('concurrent writes cannot lose an update', async () => {
  const id = randomUUID(); await change([create(id)]);
  const [record] = await db`SELECT current_revision FROM records WHERE id=${id}`;
  const operation = { op: 'edit', id, expected_revision: record.current_revision, document: doc('New evidence') };
  const results = await Promise.allSettled([change([operation]), change([operation])]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
});
test('raw originals preserve exact bytes and corrections preserve old revisions', async () => {
  const id = randomUUID(), bytes = Buffer.from('Original\r\n\u0000 exact bytes\n');
  const document = { ...doc(), tags: ['source'], metadata: { source_kind: 'user-note', source_channel: 'manual', capture_boundary: 'complete' } };
  const operation = { op: 'source', id, expected_revision: null, document, original_base64: bytes.toString('base64'), checksum: sha256(bytes) };
  await change([operation]);
  const [record] = await db`SELECT current_revision FROM records WHERE id=${id}`;
  const [saved] = await db`SELECT original FROM revisions WHERE id=${record.current_revision}`;
  expect(Buffer.from(saved.original)).toEqual(bytes);
  await expect(change([{ op: 'edit', id, expected_revision: record.current_revision, document: doc() }])).rejects.toMatchObject({ code: 'invalid_source' });
  await change([{ ...operation, expected_revision: record.current_revision, original_base64: Buffer.from('Correction').toString('base64'), checksum: sha256('Correction') }]);
  expect((await db`SELECT id FROM revisions WHERE record_id=${id}`)).toHaveLength(2);
  await expect((async () => { await db`UPDATE revisions SET body='tampered' WHERE id=${record.current_revision}`; })()).rejects.toThrow('immutable history');
});
test('factchecker cannot modify content', async () => {
  await expect(applyChange(db, { ...actor, role: 'factchecker' }, { idempotency_key: randomUUID(), operations: [create(randomUUID())] })).rejects.toMatchObject({ code: 'forbidden' });
});
test('accepted revision tags and provenance cannot be appended after sealing', async () => {
  const id=randomUUID();await change([create(id)]);
  const [record]=await db`SELECT current_revision FROM records WHERE id=${id}`;
  await expect((async()=>{await db`INSERT INTO revision_tags VALUES(${record.current_revision},'source')`;})()).rejects.toThrow('immutable revision relationships');
  await expect((async()=>{await db`INSERT INTO provenance VALUES(${randomUUID()},${record.current_revision},NULL,'https://example.invalid')`;})()).rejects.toThrow('immutable revision relationships');
});
test('related targets in same group resolve; processed records cannot be provenance', async () => {
  const a = randomUUID(), b = randomUUID();
  await change([create(a, { ...doc(), relations: [{ target: b, kind: 'related' }] }), create(b)]);
  const [record] = await db`SELECT current_revision FROM records WHERE id=${b}`;
  await expect(change([create(randomUUID(), { ...doc(), sources: [{ revision: record.current_revision }] })])).rejects.toMatchObject({ code: 'invalid_provenance' });
});
test('source order and duplicate evidence do not change content fingerprint',async()=>{
  const id=randomUUID(),sources=[{url:'https://example.invalid/first'},{url:'https://example.invalid/second'}];
  await change([create(id,{...doc(),sources})]);
  const [before]=await db`SELECT id,content_hash FROM revisions WHERE record_id=${id}`;
  await change([{op:'edit',id,expected_revision:before.id,document:{...doc(),sources:[sources[1],sources[0],sources[1]]}}]);
  const [after]=await db`SELECT v.content_hash FROM records r JOIN revisions v ON v.id=r.current_revision WHERE r.id=${id}`;
  expect(after.content_hash).toBe(before.content_hash);
});
