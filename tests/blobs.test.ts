import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, symlink, readFile,writeFile,utimes,access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore } from '../src/storage/blobs.ts';
import { connect, migrate, sha256 } from '../src/storage/database.ts';
import { anonymous, type Identity } from '../src/auth/identity.ts';
const url=process.env.TEST_DATABASE_URL;
if(!url||!new URL(url).pathname.startsWith('/wiki_test_'))throw new Error('Disposable database required');
const db=connect(url),directory=await mkdtemp(join(tmpdir(),'wiki-blobs-test-'));
const identity:Identity={actor:'blobs-test',subject:'owner',client:'personal',role:'personal'};
const store=new BlobStore(db,directory),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=','base64');
beforeAll(async()=>{await migrate(db);});
afterAll(async()=>{await db.close();await rm(directory,{recursive:true,force:true});});
test('binary preservation, duplicate intake and format/checksum validation',async()=>{
  const hash=sha256(png);
  expect((await store.ingest(identity,png,'image/png',hash)).hash).toBe(hash);
  expect((await store.ingest(identity,png,'image/png',hash)).hash).toBe(hash);
  expect(await readFile(join(directory,hash))).toEqual(png);
  await expect(store.ingest(identity,png,'image/jpeg',hash)).rejects.toMatchObject({code:'invalid_attachment'});
  await expect(store.ingest(identity,png,'image/png','0'.repeat(64))).rejects.toMatchObject({code:'invalid_attachment'});
  await expect(store.ingest(identity,Buffer.from('<svg onload="evil()"/>'),'image/svg+xml',sha256('<svg onload="evil()"/>'))).rejects.toMatchObject({code:'unsupported_format'});
  await expect(store.read(anonymous,true,hash)).rejects.toMatchObject({code:'not_found'});
  await expect(store.read(identity,true,'../../etc/passwd')).rejects.toMatchObject({code:'not_found'});
});
test('binary size boundary preserves exactly 20 MiB and rejects one extra byte without acceptance',async()=>{
  const bytes=Buffer.alloc(20*1024*1024,0x20);bytes.write('%PDF-1.7\n');const hash=sha256(bytes);
  await store.ingest(identity,bytes,'application/pdf',hash);
  expect(Buffer.from((await store.read(identity,false,hash)).bytes)).toEqual(bytes);
  const oversized=Buffer.concat([bytes,Buffer.from('x')]),rejectedHash=sha256(oversized);
  await expect(store.ingest(identity,oversized,'application/pdf',rejectedHash)).rejects.toMatchObject({code:'invalid_size'});
  expect(await db`SELECT hash FROM blobs WHERE hash=${rejectedHash}`).toHaveLength(0);
  await expect(access(join(directory,rejectedHash))).rejects.toMatchObject({code:'ENOENT'});
});
test('symlink storage payload cannot be followed even for an authorized reader',async()=>{
  const hash=sha256('linked-test');
  await symlink(join(directory,sha256(png)),join(directory,hash));
  await db`INSERT INTO blobs(hash,size,media_type) VALUES(${hash},${png.length},'image/png')`;
  await expect(store.read(identity,false,hash)).rejects.toMatchObject({code:'invalid_attachment'});
});
test('aged unaccepted final files are cleaned without removing accepted originals',async()=>{
  const orphan=sha256('interrupted-original'),path=join(directory,orphan);
  await writeFile(path,'interrupted-original');
  const yesterday=new Date(Date.now()-2*86400_000);
  await utimes(path,yesterday,yesterday);await utimes(join(directory,sha256(png)),yesterday,yesterday);
  await store.cleanStaging();
  await expect(access(path)).rejects.toMatchObject({code:'ENOENT'});
  expect(await readFile(join(directory,sha256(png)))).toEqual(png);
});
