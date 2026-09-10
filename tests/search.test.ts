import { test, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { connect, migrate } from '../src/storage/database.ts';
import { seed } from '../src/storage/seed.ts';
import { applyChange } from '../src/content/changes.ts';
import { Reader } from '../src/content/reads.ts';
import { search, regexSearch } from '../src/search/search.ts';
import { anonymous, type Identity } from '../src/auth/identity.ts';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.startsWith('/wiki_test_')) throw new Error('Disposable TEST_DATABASE_URL required');
const db = connect(url), identity: Identity = { actor:'search-test',role:'personal',subject:'owner',client:'personal' };
const reader = new Reader(db,identity,{publicEnabled:false});
beforeAll(async () => {
  await migrate(db); await seed(db);
  await applyChange(db,identity,{idempotency_key:randomUUID(),operations:[{op:'create',id:randomUUID(),type:'concept',document:{title:'Evidence preservation',slug:'evidence-preservation',body:'Сохранение первоисточников\nPreserving original sources',metadata:{},tags:['pattern'],relations:[],sources:[],attachments:[]}}]});
});
afterAll(async () => { await db.close(); });
test('PostgreSQL FTS finds EN and RU inflections', async () => {
  expect((await search(reader,{query:'preserve sources',mode:'strict',limit:10})).length).toBeGreaterThan(0);
  expect((await search(reader,{query:'сохранения первоисточника',mode:'strict',limit:10})).length).toBeGreaterThan(0);
});
test('broad and auto can broaden strict terms', async () => {
  expect(await search(reader,{query:'sources nonexistentword',mode:'strict',limit:10})).toHaveLength(0);
  expect((await search(reader,{query:'sources nonexistentword',mode:'auto',limit:10})).length).toBeGreaterThan(0);
});
test('public search cannot rank or excerpt private content', async () => {
  const publicReader = new Reader(db,anonymous,{publicEnabled:true});
  expect(await search(publicReader,{query:'первоисточников',mode:'broad',limit:100})).toHaveLength(0);
});
test('regex preserves line numbers, Unicode and ripgrep rejection semantics', async () => {
  const result = await regexSearch(reader,'^Preserving original',20);
  expect(result.matches.some(match => match.line === 2 && match.text === 'Preserving original sources')).toBe(true);
  await expect(regexSearch(reader,'(?<=original) sources',20)).rejects.toMatchObject({code:'invalid_pattern'});
  expect((await regexSearch(new Reader(db,anonymous,{publicEnabled:true}),'первоисточников',20)).matches).toHaveLength(0);
});
