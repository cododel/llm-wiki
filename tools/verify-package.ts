#!/usr/bin/env bun
import {readFile,readdir,lstat,access} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {strict as assert} from 'node:assert';
const root=resolve(import.meta.dir,'..');
async function files(directory:string):Promise<string[]> {
  const result:string[]=[];
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    if(entry.name==='.git')continue;
    assert.notEqual(entry.name,'node_modules','Dependencies must remain outside checkout');
    const path=join(directory,entry.name);
    if(entry.isDirectory())result.push(...await files(path));
    else if(entry.isFile())result.push(path);
  }
  return result;
}
const paths=await files(root);
for(const file of paths) {
  assert(!/\.(sqlite|db)(-|$)/.test(file),'No runtime database in distribution');
  if(!/\.(md|ts|json|ya?ml|sh)$/.test(file))continue;
  const source=await readFile(file,'utf8');
  assert(!source.includes('/root/'+'wiki')&&!source.includes('/'+'Users/'),`No machine-local paths: ${file.slice(root.length+1)}`);
  assert(!source.includes('-----BEGIN '+'PRIVATE KEY-----'),'No private key material');
  if(file.endsWith('.md')) for(const match of source.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
    const link=match[1]!;
    if(/^(https?:|#|mailto:)/.test(link))continue;
    const target=resolve(dirname(file),decodeURIComponent(link.split('#')[0]!));
    await access(target).catch(()=>{throw new Error(`Broken documentation link: ${file.slice(root.length+1)} -> ${link}`);});
  }
}
const types=['raw-source','readout','entity','concept','comparison','query','idea','note','article-draft','post-draft','meta','adr'];
for(const type of types) {
  const body=await readFile(join(root,'templates',type+'.md'),'utf8');
  assert(!body.startsWith('---'),'Templates are bodies, not frontmatter records');
}
for(const legacy of ['tools/fts5/wiki-search.ts','tools/mcp-wiki-server/server.ts','tools/factcheck/factcheck-trigger.ts','index.md','log.md']) {
  await lstat(join(root,legacy)).then(()=>{throw new Error(`Legacy runtime remains: ${legacy}`);},error=>{if(error.code!=='ENOENT')throw error;});
}
const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
for(const version of Object.values({...manifest.dependencies,...manifest.devDependencies})) assert(typeof version==='string'&&/^\d+\.\d+\.\d+$/.test(version),'Exact dependency version required');
await access(join(root,'bun.lock'));
const initialize=await readFile(join(root,'tools/initialize.ts'),'utf8');
for(const setting of ['PUBLICATION_ENABLED=0','FACTCHECK_ENABLED=0','REVIEW_ENABLED=0','REVIEW_INTERVAL_SECONDS=0'])assert(initialize.includes(setting));
console.log('Package integrity passed: twelve templates, documentation links, pins, disabled defaults and no legacy runtime/state');
