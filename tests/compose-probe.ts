import { strict as assert } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
const root=process.argv[2]!,port=process.argv[3]!;
assert(root.includes('llm-wiki-compose-test-')&&/^\d+$/.test(port),'Disposable compose fixture required');
const secret=async(name:string)=>(await readFile(join(root,'instance','secrets',name),'utf8')).trim();
const certificate=await readFile(join(root,'tls.crt'));
const cookies=new Map<string,Map<string,string>>();
async function request(host:string,path:string,init:RequestInit={}) {
  const url=new URL(path,`https://${host}`);assert.equal(url.host,host);
  const jar=cookies.get(host)??new Map<string,string>();cookies.set(host,jar);
  const headers=new Headers(init.headers);headers.set('Host',host);
  if(jar.size)headers.set('Cookie',[...jar].map(([k,v])=>`${k}=${v}`).join('; '));
  const response=await fetch(`https://127.0.0.1:${port}${url.pathname}${url.search}`,{...init,headers,redirect:'manual',tls:{ca:certificate}});
  for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0]!,i=pair.indexOf('=');jar.set(pair.slice(0,i),pair.slice(i+1));}
  return response;
}
const auth='auth.wiki.test',wiki='wiki.wiki.test',resource=`https://${wiki}/mcp`;
if(process.argv[4]==='after') {
  const saved=JSON.parse(await readFile(join(root,'accepted.json'),'utf8'));
  let response:Response|undefined;
  for(let i=0;i<40;i++) {
    response=await request(wiki,'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'wiki_get_page',arguments:{id:saved.id,contract_version:3}}})});
    if(response.status===200) break;
    await Bun.sleep(250);
  }
  assert(response?.ok,'Restart readiness');
  const result=await response.json();
  assert.equal(result.result.structuredContent.data.page.revision,saved.revision,'Published revision survives restart');
  assert(!JSON.stringify(result).includes('PRIVATE_NEW_REVISION'),'Private edit stays private after restart');
  const access=await token('factchecker','factchecker-secret',{grant_type:'client_credentials',scope:'wiki:read wiki:factcheck'});
  const resumed=await mcp('wiki_assignment_get',{job_id:saved.reviewJob,contract_version:3},access.access_token);
  assert.equal(resumed.result.structuredContent.data.progress.stage,'saved-before-restart');
  console.log('PASS restart preserves accepted publication without exposing private edits');
  process.exit(0);
}
async function json(host:string,path:string,init:RequestInit={}) {const r=await request(host,path,init);assert.equal(r.status,200,`${host}${new URL(path,`https://${host}`).pathname} status`);return r.json();}
const metadata=await json(auth,'/.well-known/openid-configuration');assert.equal(metadata.issuer,`https://${auth}`);
assert(metadata.code_challenge_methods_supported.includes('S256'));
assert(metadata.grant_types_supported.includes('client_credentials'));
async function token(client:string,secretName:string,params:Record<string,string>) {
  return json(auth,'/api/oidc/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Authorization:`Basic ${Buffer.from(`${client}:${await secret(secretName)}`).toString('base64')}`},body:new URLSearchParams({...params,resource})});
}
const machine=await token('factchecker','factchecker-secret',{grant_type:'client_credentials',scope:'wiki:read wiki:factcheck'});
assert(machine.access_token.startsWith('authelia_at_'));
async function mcp(name:string,args:Record<string,unknown>,accessToken:string) {
  const response=await request(wiki,'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',Authorization:`Bearer ${accessToken}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
  assert.equal(response.status,200,'MCP HTTP response');return response.json();
}
assert.equal((await mcp('wiki_list',{},machine.access_token)).result.isError,undefined);
assert.equal((await mcp('wiki_apply_change',{idempotency_key:randomUUID(),operations:[{op:'tag',tag:'forbidden',description:'Must be rejected'}]},machine.access_token)).result.isError,true);
console.log('PASS real machine introspection and domain authorization');
await json(auth,'/api/firstfactor',{method:'POST',headers:{'Content-Type':'application/json',Origin:`https://${auth}`},body:JSON.stringify({username:'owner',password:await secret('owner-password'),keepMeLoggedIn:false})});
async function consent(path:string) {
  let response=await request(auth,path),location=response.headers.get('location');assert(location,'Authorization redirect');
  let dest=new URL(location,`https://${auth}`);
  if(dest.host===auth) {
    const flow=dest.searchParams.get('flow_id');assert(flow,'Consent flow');
    const data=await json(auth,`/api/oidc/consent?flow_id=${flow}`);
    const accepted=await json(auth,'/api/oidc/consent',{method:'POST',headers:{'Content-Type':'application/json',Origin:`https://${auth}`},body:JSON.stringify({flow_id:flow,client_id:data.data.client_id,consent:true,pre_configure:false})});
    response=await request(auth,accepted.data.redirect_uri);location=response.headers.get('location');assert(location);dest=new URL(location);
  }
  return dest;
}
const verifier=randomBytes(32).toString('base64url'),state=randomBytes(32).toString('base64url');
const params=new URLSearchParams({client_id:'personal-agent',response_type:'code',redirect_uri:'https://client.example.invalid/callback',scope:'openid offline_access wiki:read wiki:write wiki:factcheck',resource,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
const callback=await consent('/api/oidc/authorization?'+params);assert.equal(callback.searchParams.get('state'),state);assert(callback.searchParams.get('code'));
const personal=await token('personal-agent','personal-agent-secret',{grant_type:'authorization_code',code:callback.searchParams.get('code')!,code_verifier:verifier,redirect_uri:'https://client.example.invalid/callback'});
async function introspect(accessToken:string) {
  return json(auth,'/api/oidc/introspection',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',
    Authorization:`Basic ${Buffer.from(`wiki-introspection:${await secret('introspection-secret')}`).toString('base64')}`},body:new URLSearchParams({token:accessToken})});
}
const machineIdentity=await introspect(machine.access_token),personalIdentity=await introspect(personal.access_token);
assert.equal(machineIdentity.active,true);assert.equal(personalIdentity.active,true);
assert([personalIdentity.aud].flat().includes(resource));assert([machineIdentity.aud].flat().includes(resource));
assert.notEqual(machineIdentity.sub,personalIdentity.sub);assert.notEqual(machineIdentity.client_id,personalIdentity.client_id);
const refreshed=await token('personal-agent','personal-agent-secret',{grant_type:'refresh_token',refresh_token:personal.refresh_token});
assert.notEqual(refreshed.refresh_token,personal.refresh_token);
personal.access_token=refreshed.access_token;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=','base64');
const blobHash=createHash('sha256').update(png).digest('hex');
assert(!(await mcp('wiki_ingest_attachment',{original_base64:png.toString('base64'),checksum:blobHash,media_type:'image/png'},personal.access_token)).result.isError,'Blob intake');
assert.equal((await request(wiki,`/attachments/${blobHash}`)).status,404,'Unpublished attachment denied');
const id=randomUUID();
const changed=await mcp('wiki_apply_change',{contract_version:3,idempotency_key:randomUUID(),operations:[{op:'create',id,document:{title:'Test publication',slug:'test-publication',body:'<script>evil()</script> Preserved text',attachments:[blobHash]}}]},personal.access_token);
assert(!changed.result.isError,'Personal content write');
const revision=changed.result.structuredContent.data.changed[0].revision;
const publication=await mcp('wiki_request_publication',{id,revision,attachments:[blobHash]},personal.access_token);
assert(!publication.result.isError,'Publication request');const requestId=publication.result.structuredContent.data.request_id;
const forbidden=await request(wiki,`/publications?id=${requestId}`,{headers:{Authorization:`Bearer ${personal.access_token}`}});assert.equal(forbidden.status,403);
const login=await request(wiki,'/auth/login');assert.equal(login.status,302);
const ownerCallback=await consent(login.headers.get('location')!);assert.equal(ownerCallback.host,wiki);
const ownerLogin=await request(wiki,ownerCallback.href);assert.equal(ownerLogin.status,302,'Owner callback');
const page=await request(wiki,`/publications?id=${requestId}`);assert.equal(page.status,200,'Owner approval page');
const html=await page.text();assert(!html.includes('<script>evil()'));assert(html.includes('&lt;script&gt;'));
const privateBlob=await request(wiki,`/attachments/${blobHash}`);assert.equal(privateBlob.status,200,'Owner can inspect selected private attachment');assert(Buffer.from(await privateBlob.arrayBuffer()).equals(png));
const csrf=html.match(/name="csrf" value="([^"]+)"/)?.[1];assert(csrf,'CSRF token present');
const denied=await request(wiki,`/publications?id=${requestId}`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:`https://${wiki}`},body:'csrf=wrong'});assert.equal(denied.status,403);
const approved=await request(wiki,`/publications?id=${requestId}`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:`https://${wiki}`},body:new URLSearchParams({csrf})});assert.equal(approved.status,200,'Owner confirmation');
const edited=await mcp('wiki_apply_change',{contract_version:3,idempotency_key:randomUUID(),operations:[{op:'edit',id,expected_revision:revision,patch:{title:'PRIVATE_NEW_REVISION',slug:'private-new-revision',body:'PRIVATE_NEW_REVISION',attachments:[]}}]},personal.access_token);
assert(!edited.result.isError,'Private edit after publication');
const work=await mcp('wiki_factcheck_next',{contract_version:3},machine.access_token),task=work.result.structuredContent.data.task;
assert(task,'Incremental work available');
const claimed=await mcp('wiki_assignment_claim',{job_id:task.job_id},machine.access_token);
assert(!claimed.result.isError);
const evidence=await mcp('wiki_assignment_complete',{job_id:task.job_id,claim_token:claimed.result.structuredContent.data.claim_token,
  result:{version:1,records:[{id:task.snapshots[0].id,revision:task.snapshots[0].revision,coverage:'no_claims',reason:'Synthetic acceptance text has no externally verifiable claims',claims:[]}],suggestions:[]}},machine.access_token);
assert(!evidence.result.isError,'Accepted evidence and checkpoint');
const campaign=await mcp('wiki_review_start',{ids:[id],idempotency_key:randomUUID()},personal.access_token);
assert(!campaign.result.isError);const reviewJob=campaign.result.structuredContent.data.jobs[0];
const reviewClaim=await mcp('wiki_assignment_claim',{job_id:reviewJob},machine.access_token);
assert(!(await mcp('wiki_assignment_progress',{job_id:reviewJob,claim_token:reviewClaim.result.structuredContent.data.claim_token,progress:{stage:'saved-before-restart',notes:'Retain this progress'}},machine.access_token)).result.isError);
await writeFile(join(root,'accepted.json'),JSON.stringify({id,revision,blobHash,reviewJob}));
console.log('PASS real personal PKCE, browser OIDC, CSRF, escaped content and owner-only approval');
assert.equal((await request(auth,'/api/oidc/revocation',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',
  Authorization:`Basic ${Buffer.from(`personal-agent:${await secret('personal-agent-secret')}`).toString('base64')}`},body:new URLSearchParams({token:personal.access_token})})).status,200);
assert.equal((await introspect(personal.access_token)).active,false);
const revoked=await request(wiki,'/mcp',{method:'POST',headers:{Authorization:`Bearer ${personal.access_token}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})});
assert.equal(revoked.status,401,'Revocation immediately denies MCP');
console.log('PASS resource audience, identity separation, refresh rotation and immediate revocation');
