#!/usr/bin/env bun
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
const repository=resolve(import.meta.dir,'..');
const scratch=await mkdtemp(join(tmpdir(),'llm-wiki-compose-test-'));
const instance=join(scratch,'instance'),project=`wiki-test-${randomBytes(8).toString('hex')}`;
const compose=['docker','compose','--project-name',project,'--env-file',join(instance,'compose.env'),'-f',join(repository,'compose.yml'),'-f',join(scratch,'override.yml')];
async function run(command:string[],capture=false) {
  const child=Bun.spawn(command,{cwd:repository,env:{PATH:process.env.PATH,TMPDIR:scratch},stdout:capture?'pipe':'inherit',stderr:'inherit'});
  const timer=setTimeout(()=>child.kill('SIGKILL'),180_000);
  const output=capture?await new Response(child.stdout).text():'';
  const code=await child.exited;clearTimeout(timer);
  if(code!==0) throw new Error(`${command[0]} ${command[1]} failed (${code})`);
  return output.trim();
}
let started=false,built=false;
try {
  await run([process.execPath,'run',join(repository,'tools/initialize.ts'),'--directory',instance,'--wiki-host','wiki.wiki.test','--auth-host','auth.wiki.test','--tls-email','owner@example.invalid','--factchecker']);
  const cert=Bun.spawnSync(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(scratch,'tls.key'),'-out',join(scratch,'tls.crt'),'-days','1','-subj','/CN=wiki.wiki.test','-addext','subjectAltName=DNS:wiki.wiki.test,DNS:auth.wiki.test,IP:127.0.0.1'],{stdout:'pipe',stderr:'pipe'});
  if(cert.exitCode!==0) throw new Error('Test TLS generation failed');
  await writeFile(join(scratch,'Caddyfile'),`{\n auto_https off\n}\nhttps://wiki.wiki.test {\n tls /fixture/tls.crt /fixture/tls.key\n reverse_proxy api:3000\n}\nhttps://auth.wiki.test {\n tls /fixture/tls.crt /fixture/tls.key\n reverse_proxy authelia:9091\n}\n`);
  await writeFile(join(scratch,'override.yml'),`services:
  caddy:
    ports: !override ['127.0.0.1::443']
    volumes:
      - '${scratch}/Caddyfile:/etc/caddy/Caddyfile:ro'
      - '${scratch}:/fixture:ro'
    networks:
      default:
        aliases: [wiki.wiki.test, auth.wiki.test]
  api:
    image: '${project}:local'
    environment:
      NODE_EXTRA_CA_CERTS: /fixture/tls.crt
      PUBLICATION_ENABLED: '1'
      FACTCHECK_ENABLED: '1'
      REVIEW_ENABLED: '1'
    volumes: ['${scratch}/tls.crt:/fixture/tls.crt:ro']
  worker:
    image: '${project}:local'
    environment:
      NODE_EXTRA_CA_CERTS: /fixture/tls.crt
      FACTCHECK_ENABLED: '1'
      REVIEW_ENABLED: '1'
    volumes: ['${scratch}/tls.crt:/fixture/tls.crt:ro']
`);
  await run([...compose,'config','--quiet']);
  await run([...compose,'build','api']);
  built=true;
  started=true;
  await run([...compose,'up','-d']);
  const port=(await run([...compose,'port','caddy','443'],true)).split(':').at(-1);
  if(!port||!/^\d+$/.test(port)) throw new Error('Invalid test port');
  let ready=false;
  for(let i=0;i<80;i++) {
    try {
      const response=await fetch(`https://127.0.0.1:${port}/.well-known/openid-configuration`,{headers:{Host:'auth.wiki.test'},tls:{ca:await readFile(join(scratch,'tls.crt'))}});
      if(response.ok){ready=true;break;}
    }catch{}
    await Bun.sleep(250);
  }
  if(!ready) {await run([...compose,'logs','--tail','30','authelia','api']);throw new Error('Compose auth readiness failed');}
  const subject=(await readFile(join(instance,'secrets/owner-subject'),'utf8')).trim();
  await run([...compose,'exec','-T','authelia','authelia','storage','user','identifiers','add','owner','--identifier',subject,'--config','/config/configuration.yml']);
  await run([process.execPath,'run',join(repository,'tests/compose-probe.ts'),scratch,port]);
  await run([...compose,'restart','api','worker']);
  await run([process.execPath,'run',join(repository,'tests/compose-probe.ts'),scratch,port,'after']);
  const blobArchive=Bun.spawn([...compose,'exec','-T','api','tar','-cf','-','-C','/var/lib/wiki/blobs','.'],{cwd:repository,stdout:'pipe',stderr:'inherit'});
  const blobBytes=await new Response(blobArchive.stdout).arrayBuffer();
  if(await blobArchive.exited!==0)throw new Error('Blob backup failed');
  await run([...compose,'exec','-T','api','mkdir','/tmp/blob-restore']);
  const blobRestore=Bun.spawn([...compose,'exec','-T','api','tar','-xf','-','-C','/tmp/blob-restore'],{cwd:repository,stdin:'pipe',stdout:'inherit',stderr:'inherit'});
  blobRestore.stdin.write(blobBytes);blobRestore.stdin.end();
  if(await blobRestore.exited!==0)throw new Error('Blob restore failed');
  const accepted=JSON.parse(await readFile(join(scratch,'accepted.json'),'utf8'));
  const restoredHash=await run([...compose,'exec','-T','api','sha256sum',`/tmp/blob-restore/${accepted.blobHash}`],true);
  if(!restoredHash.startsWith(accepted.blobHash+' '))throw new Error('Restored blob differs');
  await run([...compose,'stop','api','worker']);
  const dump=Bun.spawn([...compose,'exec','-T','postgres','pg_dump','-U','postgres','-Fc','wiki'],{cwd:repository,stdout:'pipe',stderr:'inherit'});
  const backup=await new Response(dump.stdout).arrayBuffer();
  if(await dump.exited!==0) throw new Error('Disposable backup failed');
  await run([...compose,'exec','-T','postgres','createdb','-U','postgres','wiki_restore']);
  const restore=Bun.spawn([...compose,'exec','-T','postgres','pg_restore','-U','postgres','-d','wiki_restore','--exit-on-error'],{cwd:repository,stdin:'pipe',stdout:'inherit',stderr:'inherit'});
  restore.stdin.write(backup);restore.stdin.end();
  if(await restore.exited!==0) throw new Error('Disposable restore failed');
  const tables=['records','revisions','revision_tags','relations','provenance','blobs','revision_blobs','publication_requests','published_blobs','audit','idempotency','revision_seals','jobs','campaigns','checkpoints','events','outbox','instance_state'];
  const fingerprint=tables.map(table=>`SELECT '${table}',md5(string_agg(row_to_json(r)::text,'' ORDER BY row_to_json(r)::text)) FROM ${table} r`).join(';');
  const before=await run([...compose,'exec','-T','postgres','psql','-U','postgres','-d','wiki','-Atc',fingerprint],true);
  const after=await run([...compose,'exec','-T','postgres','psql','-U','postgres','-d','wiki_restore','-Atc',fingerprint],true);
  if(!before||before!==after)throw new Error('Restored revision pointers differ');
  await run([...compose,'stop','authelia']);
  const authDump=Bun.spawn([...compose,'exec','-T','postgres','pg_dump','-U','postgres','-Fc','authelia'],{cwd:repository,stdout:'pipe',stderr:'inherit'});
  const authBackup=await new Response(authDump.stdout).arrayBuffer();
  if(await authDump.exited!==0)throw new Error('Auth backup failed');
  await run([...compose,'exec','-T','postgres','createdb','-U','postgres','auth_restore']);
  const authRestore=Bun.spawn([...compose,'exec','-T','postgres','pg_restore','-U','postgres','-d','auth_restore','--exit-on-error'],{cwd:repository,stdin:'pipe',stdout:'inherit',stderr:'inherit'});
  authRestore.stdin.write(authBackup);authRestore.stdin.end();
  if(await authRestore.exited!==0)throw new Error('Auth restore failed');
  const authTables=(await run([...compose,'exec','-T','postgres','psql','-U','postgres','-d','authelia','-Atc',"SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"],true)).split('\n');
  if(!authTables.length||authTables.some(name=>!/^[_a-z0-9]+$/.test(name)))throw new Error('Unexpected auth table names');
  const authFingerprint=authTables.map(table=>`SELECT '${table}',md5(string_agg(row_to_json(r)::text,'' ORDER BY row_to_json(r)::text)) FROM ${table} r`).join(';');
  const authBefore=await run([...compose,'exec','-T','postgres','psql','-U','postgres','-d','authelia','-Atc',authFingerprint],true);
  const authAfter=await run([...compose,'exec','-T','postgres','psql','-U','postgres','-d','auth_restore','-Atc',authFingerprint],true);
  if(authBefore!==authAfter)throw new Error('Restored auth state differs');
  console.log('PASS PostgreSQL and blob backup/restore preserves accepted content and original bytes');
  console.log('PASS Authelia backup/restore preserves isolated authentication state');
  console.log('Compose auth and publication integration passed; real client reconnect remains operator-owned');
} finally {
  if(started) await run([...compose,'down','--volumes','--remove-orphans']);
  if(built) await run(['docker','image','rm',`${project}:local`]);
  await rm(scratch,{recursive:true,force:true});
}
