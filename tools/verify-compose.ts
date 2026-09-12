#!/usr/bin/env bun
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {VerificationProcesses} from './verification-process.ts';
const repository=resolve(import.meta.dir,'..');
const scratch=await mkdtemp(join(tmpdir(),'llm-wiki-compose-test-'));
const instance=join(scratch,'instance'),project=`wiki-test-${randomBytes(8).toString('hex')}`;
const compose=['docker','compose','--project-name',project,'--env-file',join(instance,'compose.env'),'-f',join(repository,'compose.yml'),'-f',join(scratch,'override.yml')];
const restoredCompose=[...compose];restoredCompose[3]=`${project}-restored`;
const processes=new VerificationProcesses();
const extended=process.argv.includes('--extended');
async function run(command:string[],capture=false) {
  return new TextDecoder().decode(await processes.run(command,{cwd:repository,env:{PATH:process.env.PATH,TMPDIR:scratch},capture,
    cleanup:command.includes('down')||(command[0]==='docker'&&command[1]==='image'&&command[2]==='rm')})).trim();
}
async function transfer(command:string[],input?:Uint8Array){return processes.run(command,{cwd:repository,env:{PATH:process.env.PATH,TMPDIR:scratch},capture:true,input});}
let started=false,built=false,restoredStarted=false;
try {
  await run([process.execPath,'run',join(repository,'tools/initialize.ts'),'--directory',instance,'--wiki-host','wiki.wiki.test','--auth-host','auth.wiki.test','--tls-email','owner@example.invalid','--factchecker']);
  // Exercise Linux container permissions as the PostgreSQL UID, without reading secrets into logs.
  for(const name of ['wiki-db-password','auth-db-password'])await run(['docker','run','--rm','--user','70:70',
    '--mount',`type=bind,source=${join(instance,'secrets',name)},target=/fixture/secret,readonly`,
    'postgres:17.11-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73',
    'sh','-c','test -r /fixture/secret']);
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
  if(extended){
    await run([...compose,'stop','authelia']);
    await run([process.execPath,'run',join(repository,'tests/compose-probe.ts'),scratch,port,'auth-down']);
    await run([...compose,'start','authelia']);
    await run([...compose,'restart','postgres']);
    await run([process.execPath,'run',join(repository,'tests/compose-probe.ts'),scratch,port,'after']);
  }
  // Stop writers before capturing either half of a coordinated backup.
  await run([...compose,'stop','api','worker']);
  const blobBytes=await transfer([...compose,'run','--rm','--no-deps','-T','api','tar','-cf','-','-C','/var/lib/wiki/blobs','.']);
  // A disposable one-shot reader verifies the archive before any fresh-stack restore.
  const blobCheck=await transfer([...compose,'run','--rm','--no-deps','-T','api','sh','-c','mkdir /tmp/blob-restore && tar -xf - -C /tmp/blob-restore && find /tmp/blob-restore -type f -exec sha256sum {} \\;'],blobBytes);
  const accepted=JSON.parse(await readFile(join(scratch,'accepted.json'),'utf8'));
  if(!new TextDecoder().decode(blobCheck).includes(accepted.blobHash+' '))throw new Error('Restored blob differs');
  const backup=await transfer([...compose,'exec','-T','postgres','pg_dump','-U','postgres','-Fc','wiki']);
  await run([...compose,'exec','-T','postgres','createdb','-U','postgres','wiki_restore']);
  await transfer([...compose,'exec','-T','postgres','pg_restore','-U','postgres','-d','wiki_restore','--exit-on-error'],backup);
  const tables=['records','revisions','revision_tags','relations','provenance','blobs','revision_blobs','publication_requests','published_blobs','audit','idempotency','revision_seals','jobs','campaigns','checkpoints','events','outbox','instance_state',
    'revision_details','sources','skills','skill_revisions','skill_dependencies','revision_skill_links','derivations','terms','revision_terms','legacy_term_map','collections','collection_members','legacy_backfill_pending'];
  const fingerprint=tables.map(table=>`SELECT '${table}',md5(string_agg(row_to_json(r)::text,'' ORDER BY row_to_json(r)::text)) FROM ${table} r`).join(';');
  const before=await run([...compose,'exec','-T','postgres','psql','-U','postgres','-d','wiki','-Atc',fingerprint],true);
  const after=await run([...compose,'exec','-T','postgres','psql','-U','postgres','-d','wiki_restore','-Atc',fingerprint],true);
  if(!before||before!==after)throw new Error('Restored revision pointers differ');
  await run([...compose,'stop','authelia']);
  const authBackup=await transfer([...compose,'exec','-T','postgres','pg_dump','-U','postgres','-Fc','authelia']);
  await run([...compose,'exec','-T','postgres','createdb','-U','postgres','auth_restore']);
  await transfer([...compose,'exec','-T','postgres','pg_restore','-U','postgres','-d','auth_restore','--exit-on-error'],authBackup);
  const authTables=(await run([...compose,'exec','-T','postgres','psql','-U','postgres','-d','authelia','-Atc',"SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"],true)).split('\n');
  if(!authTables.length||authTables.some(name=>!/^[_a-z0-9]+$/.test(name)))throw new Error('Unexpected auth table names');
  const authFingerprint=authTables.map(table=>`SELECT '${table}',md5(string_agg(row_to_json(r)::text,'' ORDER BY row_to_json(r)::text)) FROM ${table} r`).join(';');
  const authBefore=await run([...compose,'exec','-T','postgres','psql','-U','postgres','-d','authelia','-Atc',authFingerprint],true);
  const authAfter=await run([...compose,'exec','-T','postgres','psql','-U','postgres','-d','auth_restore','-Atc',authFingerprint],true);
  if(authBefore!==authAfter)throw new Error('Restored auth state differs');
  console.log('PASS PostgreSQL and blob backup/restore preserves accepted content and original bytes');
  console.log('PASS Authelia backup/restore preserves isolated authentication state');
  if(extended){
    restoredStarted=true;
    await run([...restoredCompose,'up','-d','--wait','postgres']);
    await transfer([...restoredCompose,'exec','-T','postgres','pg_restore','-U','postgres','-d','wiki','--exit-on-error'],new Uint8Array(backup));
    await transfer([...restoredCompose,'exec','-T','postgres','pg_restore','-U','postgres','-d','authelia','--exit-on-error'],new Uint8Array(authBackup));
    await transfer([...restoredCompose,'run','--rm','--no-deps','-T','api','tar','-xf','-','-C','/var/lib/wiki/blobs'],new Uint8Array(blobBytes));
    await run([...restoredCompose,'up','-d']);
    const restoredPort=(await run([...restoredCompose,'port','caddy','443'],true)).split(':').at(-1);
    if(!restoredPort||!/^\d+$/.test(restoredPort))throw new Error('Invalid restored test port');
    await run([process.execPath,'run',join(repository,'tests/compose-probe.ts'),scratch,restoredPort,'restored']);
    // A new authenticated write/publication/work cycle must work on the restored service.
    await run([process.execPath,'run',join(repository,'tests/compose-probe.ts'),scratch,restoredPort,'restored-cycle']);
    console.log('PASS fresh Compose restores original evidence and resumes work, then accepts authenticated writes and publication');
  }
  console.log('Compose auth and publication integration passed; real client reconnect remains operator-owned');
} finally {
  try{if(restoredStarted)await run([...restoredCompose,'down','--volumes','--remove-orphans']);}
  finally{try{if(started) await run([...compose,'down','--volumes','--remove-orphans']);}
    finally{try{if(built) await run(['docker','image','rm',`${project}:local`]);}
      finally{await rm(scratch,{recursive:true,force:true});processes.close();}}}
}
