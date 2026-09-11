import { test, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, migrate } from '../src/storage/database.ts';
import { seed } from './legacy-seed.ts';
import { createMcp } from '../src/mcp/server.ts';
import { BlobStore } from '../src/storage/blobs.ts';
import type { Identity } from '../src/auth/identity.ts';
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.startsWith('/wiki_test_')) throw new Error('Disposable TEST_DATABASE_URL required');
const db=connect(url), identity:Identity={actor:'mcp-test',subject:'owner',client:'personal',role:'personal'};
const scratch=await mkdtemp(join(tmpdir(),'wiki-mcp-assets-'));
const server=createMcp({db,identity,publicationEnabled:false,blobs:new BlobStore(db,scratch),work:{factcheck:false,review:false,concurrency:{factcheck:1,review:1},leaseSeconds:300,maxAttempts:3}});
const client=new Client({name:'test-client',version:'1'});
beforeAll(async () => {
  await migrate(db);await seed(db);
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
});
afterAll(async () => {await client.close();await server.close();await db.close();await rm(scratch,{recursive:true,force:true});});
test('v2 includes 11 read names and never exposes publication approval', async () => {
  const names=(await client.listTools()).tools.map(t=>t.name);
  for(const name of ['wiki_search','wiki_search_and_read','wiki_regex_search','wiki_get_page','wiki_get_related','wiki_resolve','wiki_list','wiki_get_sources','wiki_health_summary','wiki_lint_summary','wiki_audit_visibility']) expect(names).toContain(name);
  expect(names.some(name=>name.includes('approve'))).toBe(false);
});
test('MCP writes and reads typed stable-ID revision results', async () => {
  const id=randomUUID();
  const created=await client.callTool({name:'wiki_apply_change',arguments:{idempotency_key:randomUUID(),operations:[{op:'create',id,type:'note',document:{title:'MCP test',slug:'mcp-test',body:'Typed content',metadata:{},tags:['learning'],relations:[],sources:[],attachments:[]}}]}});
  expect(created.isError).not.toBe(true);
  const page=await client.callTool({name:'wiki_get_page',arguments:{id}});
  expect(page.isError).not.toBe(true);
  expect(JSON.stringify(page.structuredContent)).toContain('Typed content');
  for(const name of ['wiki_get_sources','wiki_get_related']) expect((await client.callTool({name,arguments:{id}})).isError).not.toBe(true);
  for(const name of ['wiki_health_summary','wiki_lint_summary','wiki_audit_visibility','wiki_list']) expect((await client.callTool({name,arguments:{}})).isError).not.toBe(true);
  expect((await client.callTool({name:'wiki_resolve',arguments:{name:'mcp-test'}})).isError).not.toBe(true);
  for(const name of ['wiki_search','wiki_search_and_read']) expect((await client.callTool({name,arguments:{query:'Typed content'}})).isError).not.toBe(true);
  expect((await client.callTool({name:'wiki_regex_search',arguments:{pattern:'Typed content'}})).isError).not.toBe(true);
});
test('old path arguments and unexpected fields are not silently accepted', async () => {
  const response=await client.callTool({name:'wiki_get_page',arguments:{path:'notes/private.md'}});
  expect(response.isError).toBe(true);
});
test('memoryless client discovers v3, creates a bodyless record and reads its full contract',async()=>{
  const description=await client.callTool({name:'wiki_describe',arguments:{}});
  expect(description.isError).not.toBe(true);
  expect(JSON.stringify(description.structuredContent)).toContain('contract_version');
  const id=randomUUID();
  const created=await client.callTool({name:'wiki_apply_change',arguments:{contract_version:3,idempotency_key:randomUUID(),operations:[{op:'create',id,document:{title:'Native inbox'}}]}});
  expect(created.isError).not.toBe(true);
  for(const name of ['wiki_get_page','wiki_context','wiki_get_related','wiki_get_sources']) {
    const arguments_=name==='wiki_context'?{ids:[id]}:{id,contract_version:3};
    const response=await client.callTool({name,arguments:arguments_});
    expect(response.isError).not.toBe(true);
  }
  const old=await client.callTool({name:'wiki_get_page',arguments:{id}});
  expect(JSON.stringify(old.structuredContent)).toContain('unsupported_contract');
  const tags=await client.callTool({name:'wiki_tags',arguments:{contract_version:3,mode:'suggest',id}});
  expect(JSON.stringify(tags.structuredContent)).toContain('unsupported_contract');
  for(const name of ['wiki_list','wiki_health_summary','wiki_lint_summary','wiki_audit_visibility','wiki_skills_list']) {
    expect((await client.callTool({name,arguments:{contract_version:3}})).isError).not.toBe(true);
  }
  await db`UPDATE records SET archived=true WHERE id=${id}`;
  expect(JSON.stringify((await client.callTool({name:'wiki_get_page',arguments:{id}})).structuredContent)).toContain('unsupported_contract');
  expect(JSON.stringify((await client.callTool({name:'wiki_tags',arguments:{mode:'suggest',id}})).structuredContent)).toContain('unsupported_contract');
});
