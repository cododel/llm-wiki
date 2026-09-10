#!/usr/bin/env bun
import { mkdir, open, realpath } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`), value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} is required`);
  return value;
}
const directory = resolve(argument('directory'));
const repository = await realpath(resolve(import.meta.dir,'..'));
const parent = await realpath(resolve(directory,'..'));
const target = join(parent,directory.split('/').at(-1)!);
const rel = relative(repository,target);
if (rel !== '..' && !rel.startsWith('../')) throw new Error('Instance secrets must be outside the repository');
const wikiHost=argument('wiki-host'),authHost=argument('auth-host'),email=argument('tls-email');
for (const host of [wikiHost,authHost]) if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw new Error('Use DNS hostnames without protocol, path or port');
if (wikiHost === authHost) throw new Error('Wiki and authentication need distinct hostnames');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('TLS email is invalid');
const wikiOrigin=`https://${wikiHost}`,issuer=`https://${authHost}`;
await mkdir(directory,{mode:0o700});
await mkdir(join(directory,'secrets'),{mode:0o700});await mkdir(join(directory,'authelia'),{mode:0o700});
async function save(path: string, value: string) {
  // Parent directories remain owner-only. Individual Docker secret mounts must be
  // readable by the unprivileged API process; other host users cannot traverse them.
  const mounted = ['secrets/database-url','secrets/auth-grants.json','secrets/introspection-secret','secrets/browser-secret','secrets/session-key'];
  const file=await open(join(directory,path),'wx',mounted.includes(path) ? 0o644 : 0o600);
  try { await file.writeFile(value);await file.sync(); } finally {await file.close();}
}
const secret=()=>randomBytes(32).toString('hex');
const postgresPassword=secret(),wikiPassword=secret(),authPassword=secret(),browserSecret=secret(),personalSecret=secret(),checkerSecret=secret(),introspectionSecret=secret(),ownerPassword=secret(),ownerSubject=randomUUID();
for(const [path,value] of Object.entries({
  'postgres-password':postgresPassword,'wiki-db-password':wikiPassword,'auth-db-password':authPassword,
  'database-url':`postgres://wiki:${wikiPassword}@postgres:5432/wiki`,
  'introspection-secret':introspectionSecret,'browser-secret':browserSecret,'personal-agent-secret':personalSecret,
  'factchecker-secret':checkerSecret,'owner-password':ownerPassword,'owner-subject':ownerSubject,'session-key':secret(),
})) await save(`secrets/${path}`,value);
const grants=[{subject:ownerSubject,client:'personal-agent',role:'personal'},{subject:ownerSubject,client:'owner-browser',role:'owner'}];
if(process.argv.includes('--factchecker')) grants.push({subject:'factchecker',client:'factchecker',role:'factchecker'});
await save('secrets/auth-grants.json',JSON.stringify(grants,null,2));
const clients = await Promise.all([
  {id:'personal-agent',secret:personalSecret,scopes:['openid','offline_access','wiki:read','wiki:write','wiki:factcheck'],machine:false},
  {id:'owner-browser',secret:browserSecret,scopes:['openid','offline_access','wiki:owner'],machine:false},
  {id:'factchecker',secret:checkerSecret,scopes:['wiki:read','wiki:factcheck'],machine:true},
  {id:'wiki-introspection',secret:introspectionSecret,scopes:['wiki:read'],machine:true},
].map(async client=>({client_id:client.id,client_name:client.id,public:false,client_secret:await Bun.password.hash(client.secret,{algorithm:'argon2id'}),
  audience:[`${wikiOrigin}/mcp`],scopes:client.scopes,grant_types:client.machine?['client_credentials']:['authorization_code','refresh_token'],response_types:['code'],
  redirect_uris:client.id==='owner-browser'?[`${wikiOrigin}/auth/callback`]:client.id==='personal-agent'?['https://client.example.invalid/callback']:[],
  authorization_policy:'one_factor',require_pkce:!client.machine,pkce_challenge_method:'S256',consent_mode:'explicit',token_endpoint_auth_method:'client_secret_basic'})));
const key=generateKeyPairSync('rsa',{modulusLength:3072,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
await save('authelia/configuration.yml',Bun.YAML.stringify({
  server:{address:'tcp://:9091'},log:{level:'warn'},
  authentication_backend:{file:{path:'/config/users.yml'},password_reset:{disable:true}},
  access_control:{default_policy:'deny',rules:[{domain:wikiHost,policy:'one_factor'}]},
  session:{secret:secret(),cookies:[{domain:authHost,authelia_url:issuer}]},
  storage:{encryption_key:secret(),postgres:{address:'tcp://postgres:5432',database:'authelia',username:'authelia',password:authPassword}},
  notifier:{filesystem:{filename:'/notifications/notifications.txt'}},
  identity_providers:{oidc:{hmac_secret:randomBytes(64).toString('hex'),jwks:[{key_id:'wiki-oidc',algorithm:'RS256',use:'sig',key:key.privateKey}],clients}},
}));
await save('authelia/users.yml',Bun.YAML.stringify({users:{owner:{displayname:'Wiki Owner',password:await Bun.password.hash(ownerPassword,{algorithm:'argon2id'}),email,groups:['owners']}}}));
await save('wiki.env',[
  `WIKI_ORIGIN=${wikiOrigin}`,`AUTH_ISSUER=${issuer}`,
  'DATABASE_URL_FILE=/run/secrets/database_url','AUTH_GRANTS_FILE=/run/secrets/auth_grants',
  'AUTH_INTROSPECTION_SECRET_FILE=/run/secrets/introspection_secret','AUTH_BROWSER_SECRET_FILE=/run/secrets/browser_secret',
  'SESSION_ENCRYPTION_KEY_FILE=/run/secrets/session_key','PUBLICATION_ENABLED=0','FACTCHECK_ENABLED=0','REVIEW_ENABLED=0','REVIEW_INTERVAL_SECONDS=0',
].join('\n')+'\n');
await save('compose.env',`INSTANCE_DIR=${directory}\nWIKI_HOST=${wikiHost}\nAUTH_HOST=${authHost}\nTLS_EMAIL=${email}\n`);
console.log(`Prepared instance configuration in ${directory}. No containers, schedules or external services were started.`);
console.log('Before first login, register the generated owner-subject using the documented Authelia storage CLI. Configure the personal-agent redirect URI before connecting a client.');
