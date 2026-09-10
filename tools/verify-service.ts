#!/usr/bin/env bun
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const repository = resolve(import.meta.dir, '..');
const scratch = await mkdtemp(join(tmpdir(), 'llm-wiki-service-test-'));
const suffix = randomBytes(8).toString('hex');
const container = `llm-wiki-test-${suffix}`;
const database = `wiki_test_${suffix}`;
let started = false;
async function run(command: string[], env: Record<string, string> = {}, capture = false): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: scratch,
    env: { PATH: process.env.PATH, TMPDIR: scratch, ...env },
    stdout: capture ? 'pipe' : 'inherit', stderr: 'inherit',
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000);
  const output = capture ? await new Response(child.stdout).text() : '';
  const code = await child.exited;
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`${command[0]} ${command[1]} failed`);
  return output.trim();
}
try {
  for (const path of ['src','tests','migrations','package.json','bun.lock','tsconfig.json']) {
    await cp(join(repository, path), join(scratch, path), { recursive: true });
  }
  await run([process.execPath, 'install', '--frozen-lockfile', '--ignore-scripts']);
  await run([process.execPath, 'node_modules/typescript/bin/tsc', '--project', 'tsconfig.json']);
  await run(['docker','run','-d','--name',container,'--label',`llm-wiki-test=${suffix}`,
    '-e','POSTGRES_HOST_AUTH_METHOD=trust','-e',`POSTGRES_DB=${database}`,'-p','127.0.0.1::5432',
    '--tmpfs','/var/lib/postgresql/data','postgres:17.11-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73'], {}, true);
  started = true;
  const port = (await run(['docker','port',container,'5432'], {}, true)).split(':').at(-1);
  if (!port || !/^\d+$/.test(port)) throw new Error('Unexpected isolated database port');
  for (let attempt = 0; ; attempt++) {
    const check = Bun.spawnSync(['docker','exec',container,'pg_isready','-h','127.0.0.1','-U','postgres'], { stdout:'pipe',stderr:'pipe' });
    if (check.exitCode === 0) break;
    if (attempt >= 40) throw new Error('Disposable PostgreSQL failed readiness');
    await Bun.sleep(250);
  }
  await run([process.execPath, 'test', '--timeout', '30000', 'tests'], {
    TEST_DATABASE_URL: `postgres://postgres@127.0.0.1:${port}/${database}`,
  });
  console.log('Service verification passed against disposable PostgreSQL');
} finally {
  if (started) await run(['docker','rm','-f',container]);
  await rm(scratch, { recursive: true, force: true });
}
