import { readFile } from 'node:fs/promises';
import type { AuthConfig, Identity } from '../auth/identity.ts';
import type { BrowserConfig } from '../auth/browser.ts';
import type { WorkSettings } from '../factcheck/protocol.ts';
import type { Destinations } from '../delivery/outbox.ts';
const { z } = await import('zod');
const httpsUrl = z.string().url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash; });
const grantsSchema = z.array(z.object({ subject:z.string().min(1),client:z.string().min(1),role:z.enum(['personal','owner','factchecker']),capabilities:z.array(z.literal('manage_locks')).max(1).optional() }).strict()).min(2);
export interface Config {
  databaseUrl: string; blobDirectory: string; origin: string; port: number; auth: AuthConfig; browser: BrowserConfig;
  publicationEnabled: boolean; work: WorkSettings; destinations: Destinations; reviewIntervalSeconds: number; workerIdentity: Identity;
}
async function secret(env: NodeJS.ProcessEnv, name: string): Promise<string> {
  const path = env[`${name}_FILE`];
  if (!path) throw new Error(`${name}_FILE is required`);
  const value = (await readFile(path, 'utf8')).trim();
  if (!value) throw new Error(`${name}_FILE is empty`);
  return value;
}
function number(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) {
  return z.coerce.number().int().min(min).max(max).parse(env[name] ?? fallback);
}
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const origin = httpsUrl.parse(env.WIKI_ORIGIN).replace(/\/$/,''), issuer = httpsUrl.parse(env.AUTH_ISSUER).replace(/\/$/,'');
  if (new URL(origin).pathname !== '/' || new URL(issuer).pathname !== '/') throw new Error('Origin and issuer must not contain a path');
  const grants = grantsSchema.parse(JSON.parse(await secret(env,'AUTH_GRANTS')));
  const keys = new Set(grants.map(g => JSON.stringify([g.subject,g.client])));
  if (keys.size !== grants.length) throw new Error('Duplicate local identity grants');
  const owner = grants.filter(g => g.role === 'owner');
  if (owner.length !== 1 || !grants.some(g => g.role === 'personal')) throw new Error('One browser owner and a personal agent grant are required');
  const auth: AuthConfig = { issuer,audience:`${origin}/mcp`,introspectionEndpoint:`${issuer}/api/oidc/introspection`,
    introspectionClient:env.AUTH_INTROSPECTION_CLIENT ?? 'wiki-introspection',introspectionSecret:await secret(env,'AUTH_INTROSPECTION_SECRET'),grants };
  const browser: BrowserConfig = { origin,clientId:owner[0]!.client,clientSecret:await secret(env,'AUTH_BROWSER_SECRET'),
    authorizationEndpoint:`${issuer}/api/oidc/authorization`,tokenEndpoint:`${issuer}/api/oidc/token`,jwksEndpoint:`${issuer}/jwks.json`,encryptionKey:await secret(env,'SESSION_ENCRYPTION_KEY') };
  const destinations: Destinations = {};
  for (const kind of ['factcheck','review','notification'] as const) {
    const name = kind.toUpperCase();
    if (env[`${name}_WEBHOOK_URL`]) destinations[kind] = { url:httpsUrl.parse(env[`${name}_WEBHOOK_URL`]),secret:await secret(env,`${name}_WEBHOOK_SECRET`) };
  }
  return { databaseUrl:await secret(env,'DATABASE_URL'),blobDirectory:env.BLOB_DIR ?? '/var/lib/wiki/blobs',origin,
    port:number(env,'PORT',3000,1,65535),auth,browser,publicationEnabled:env.PUBLICATION_ENABLED === '1',destinations,
    reviewIntervalSeconds:number(env,'REVIEW_INTERVAL_SECONDS',0,0,31536000),
    work: { factcheck:env.FACTCHECK_ENABLED === '1',review:env.REVIEW_ENABLED === '1',concurrency:{ factcheck:number(env,'FACTCHECK_CONCURRENCY',1,1,20),review:number(env,'REVIEW_CONCURRENCY',1,1,20) },
      leaseSeconds:number(env,'WORK_LEASE_SECONDS',300,30,3600),maxAttempts:number(env,'WORK_MAX_ATTEMPTS',3,1,10) },
    workerIdentity:{ actor:'service:worker',subject:'service',client:'worker',role:'personal' } };
}
