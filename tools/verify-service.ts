#!/usr/bin/env bun
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {VerificationProcesses} from './verification-process.ts';

const repository = resolve(import.meta.dir, '..');
const scratch = await mkdtemp(join(tmpdir(), 'llm-wiki-service-test-'));
const suffix = randomBytes(8).toString('hex');
const container = `llm-wiki-test-${suffix}`;
const database = `wiki_test_${suffix}`;
let started = false;
const processes=new VerificationProcesses(),endurance=process.argv.includes('--endurance');
async function run(command: string[], env: Record<string, string> = {}, capture = false): Promise<string> {
  return new TextDecoder().decode(await processes.run(command,{cwd:scratch,
    env:{PATH:process.env.PATH,TMPDIR:scratch,VERIFICATION_REPORT_DIR:process.env.VERIFICATION_REPORT_DIR,...env},capture,
    timeout:command.includes('tests/endurance-probe.ts')?5_100_000:180_000,cleanup:command[0]==='docker'&&command[1]==='rm'})).trim();
}
try {
  for (const path of ['src','tests','tools','migrations','package.json','bun.lock','tsconfig.json']) {
    await cp(join(repository, path), join(scratch, path), { recursive: true });
  }
  await run([process.execPath, 'install', '--frozen-lockfile', '--ignore-scripts']);
  await run([process.execPath, 'node_modules/typescript/bin/tsc', '--project', 'tsconfig.json']);
  started = true;
  await run(['docker','run','-d','--name',container,'--label',`llm-wiki-test=${suffix}`,
    '-e','POSTGRES_HOST_AUTH_METHOD=trust','-e',`POSTGRES_DB=${database}`,'-p','127.0.0.1::5432',
    '--tmpfs','/var/lib/postgresql/data','postgres:17.11-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'], {}, true);
  const port = (await run(['docker','port',container,'5432'], {}, true)).split(':').at(-1);
  if (!port || !/^\d+$/.test(port)) throw new Error('Unexpected isolated database port');
  for (let attempt = 0; ; attempt++) {
    const check = Bun.spawnSync(['docker','exec',container,'pg_isready','-h','127.0.0.1','-U','postgres'], { stdout:'pipe',stderr:'pipe' });
    if (check.exitCode === 0) break;
    if (attempt >= 40) throw new Error('Disposable PostgreSQL failed readiness');
    await Bun.sleep(250);
  }
  if(endurance){
    await run([process.execPath,'run','tests/endurance-probe.ts',...(process.argv.includes('--smoke')?['--smoke']:[])],{TEST_DATABASE_URL:`postgres://postgres@127.0.0.1:${port}/${database}`});
  }else{
    await run([process.execPath, 'test', '--timeout', '30000', '--reporter=junit', '--reporter-outfile',process.env.VERIFICATION_REPORT_DIR?join(process.env.VERIFICATION_REPORT_DIR,'service-tests.xml'):join(scratch,'service-tests.xml'),'tests'], {
      TEST_DATABASE_URL: `postgres://postgres@127.0.0.1:${port}/${database}`,
    });
    await run([process.execPath,'run','tests/load-probe.ts'],{TEST_DATABASE_URL:`postgres://postgres@127.0.0.1:${port}/${database}`});
  }
  console.log('Service verification passed against disposable PostgreSQL');
} finally {
  try{if (started) await run(['docker','rm','-f',container]);}
  finally{await rm(scratch, { recursive: true, force: true });processes.close();}
}
