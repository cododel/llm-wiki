// OAuth security regression suite adapted from the original implementation.
// All identities, passwords, clients, domains, and signing keys are synthetic.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, importPKCS8 } from "jose";
import { createOAuthService, type OAuthService } from "./oauth.ts";
const issuer = "https://mcp.example.test";
const resource = `${issuer}/admin/mcp`;
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const password = "synthetic test password, not a deployment credential";
let dir: string; let service: OAuthService; let privateKeyPem: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "llm-wiki-oauth-")); const pair = generateKeyPairSync("ed25519");
  privateKeyPem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  service = createOAuthService({ issuer, resource, dbPath: join(dir, "oauth.sqlite"), ownerUsername: "owner",
    ownerPasswordHash: await Bun.password.hash(password, { algorithm: "bcrypt", cost: 4 }), privateKeyPem,
    publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(), requiredScopes: ["mcp:admin"],
    maxClients: 2, maxPendingAuthorizations: 2, maxRateBuckets: 10 });
});
afterEach(() => { service?.close(); rmSync(dir, { recursive: true, force: true }); });
async function request(path: string, init?: RequestInit): Promise<Response> {
  const result = await service.handleRoute(new Request(`${issuer}${path}`, init));
  if (!result) throw new Error(`Unhandled OAuth test route ${path}`); return result;
}
const form = (values: Record<string, string>, headers: Record<string, string> = {}): RequestInit => ({ method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(values) });
function hidden(html: string, name: string): string {
  const value = new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1];
  if (!value) throw new Error(`Missing form field ${name}`); return value;
}
async function registerClient(redirect = "https://client.example/callback"): Promise<string> {
  const response = await request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test MCP Client", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
  expect(response.status).toBe(201); const body: { client_id: string } = await response.json(); return body.client_id;
}
function authQuery(clientId: string): URLSearchParams {
  return new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://client.example/callback",
    scope: "mcp:admin", state: "state-123", code_challenge: challenge, code_challenge_method: "S256", resource });
}
async function pendingLogin(clientId: string): Promise<{ request_id: string; csrf: string }> {
  const response = await request(`/oauth/authorize?${authQuery(clientId)}`); expect(response.status).toBe(200);
  const html = await response.text(); return { request_id: hidden(html, "request_id"), csrf: hidden(html, "csrf") };
}
async function authorize(clientId: string): Promise<string> {
  const pending = await pendingLogin(clientId);
  const loggedIn = await request("/login", form({ ...pending, username: "owner", password })); expect(loggedIn.status).toBe(303);
  const cookie = loggedIn.headers.get("set-cookie"); const location = loggedIn.headers.get("location");
  if (!cookie || !location) throw new Error("Login did not return a session and redirect");
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax"]) expect(cookie).toContain(attribute);
  const consent = await request(location, { headers: { cookie } }); expect(consent.status).toBe(200);
  const html = await consent.text();
  for (const value of ["Test MCP Client", "https://client.example/callback", "mcp:admin", resource]) expect(html).toContain(value);
  const approved = await request("/oauth/approve", form({ request_id: hidden(html, "request_id"), csrf: hidden(html, "csrf"), decision: "approve" }, { cookie }));
  expect(approved.status).toBe(302); const callback = new URL(approved.headers.get("location") ?? "");
  expect(callback.origin + callback.pathname).toBe("https://client.example/callback");
  expect(callback.searchParams.get("state")).toBe("state-123"); expect(callback.searchParams.get("iss")).toBe(issuer);
  const code = callback.searchParams.get("code"); if (!code) throw new Error("No authorization code"); return code;
}
function exchangeCode(clientId: string, code: string, codeVerifier = verifier): Promise<Response> {
  return request("/oauth/token", form({ grant_type: "authorization_code", code, client_id: clientId,
    redirect_uri: "https://client.example/callback", code_verifier: codeVerifier, resource }));
}
function rotate(clientId: string, refresh: string): Promise<Response> {
  return request("/oauth/token", form({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId, resource }));
}
type Tokens = { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string };

test("SQLite database and WAL state are mode 0600", () => {
  for (const suffix of ["", "-wal", "-shm"]) expect(statSync(join(dir, `oauth.sqlite${suffix}`)).mode & 0o777).toBe(0o600);
});
test("discovery publishes canonical protected-resource and authorization-server metadata", async () => {
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/admin/mcp"]) {
    const response = await request(path); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resource, authorization_servers: [issuer], scopes_supported: ["mcp:admin"], bearer_methods_supported: ["header"] });
  }
  expect(await (await request("/.well-known/oauth-authorization-server")).json()).toMatchObject({ issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`, registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"], authorization_response_iss_parameter_supported: true });
  const jwks: { keys: Array<Record<string, unknown>> } = await (await request("/.well-known/jwks.json")).json();
  expect(jwks.keys[0].kty).toBe("OKP"); expect(jwks.keys[0]).not.toHaveProperty("d");
});
test("DCR accepts public clients/loopback and rejects unsafe redirects; capacity is bounded", async () => {
  expect(await registerClient()).toStartWith("mcp_client_");
  for (const redirect of ["http://evil.example/callback", "https://client.example/callback#fragment", "https://*.example/callback", "https://user:password@client.example/cb"]) {
    const res = await request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect], token_endpoint_auth_method: "none" }) });
    expect(res.status).toBe(400);
  }
  expect(await registerClient("http://127.0.0.1:4567/callback")).toStartWith("mcp_client_");
  const full = await request("/oauth/register", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.50" }, body: JSON.stringify({ redirect_uris: ["https://third.example/callback"] }) });
  expect(full.status).toBe(429);
});
test("rate-limit memory is bounded even with many distinct forwarded IP values", async () => {
  for (let i = 0; i < 10; i++) expect((await request("/oauth/register", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `192.0.2.${i + 1}` }, body: "{}" })).status).toBe(400);
  expect((await request("/oauth/register", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.200" }, body: "{}" })).status).toBe(429);
});
test("authorization requires exact audience/redirect and PKCE S256", async () => {
  const client = await registerClient();
  for (const changes of [{ code_challenge_method: "" }, { code_challenge_method: "plain" }, { resource: issuer }, { redirect_uri: "https://evil.example/cb" }]) {
    const query = authQuery(client); for (const [key, value] of Object.entries(changes)) query.set(key, value);
    expect((await request(`/oauth/authorize?${query}`)).status).toBe(400);
  }
});
test("pending authorizations have bounded storage", async () => {
  const client = await registerClient();
  expect((await request(`/oauth/authorize?${authQuery(client)}`)).status).toBe(200);
  expect((await request(`/oauth/authorize?${authQuery(client)}`)).status).toBe(200);
  expect((await request(`/oauth/authorize?${authQuery(client)}`)).status).toBe(429);
});
test("login and approval reject missing session, wrong password, and wrong CSRF", async () => {
  const pending = await pendingLogin(await registerClient());
  expect((await request("/login", form({ ...pending, csrf: "wrong", username: "owner", password }))).status).toBe(400);
  expect((await request("/login", form({ ...pending, username: "owner", password: "wrong" }))).status).toBe(401);
  expect((await request("/oauth/approve", form({ ...pending, decision: "approve" }))).status).toBe(401);
});
test("Authorization Code flow verifies PKCE, issues scoped JWT, and consumes code once", async () => {
  const client = await registerClient(); const code = await authorize(client);
  expect((await exchangeCode(client, code, verifier + "x")).status).toBe(400);
  const response = await exchangeCode(client, code); expect(response.status).toBe(200); const tokens: Tokens = await response.json();
  expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 900, scope: "mcp:admin" });
  expect(tokens.access_token).toBeTruthy(); expect(tokens.refresh_token).toBeTruthy();
  expect(await service.authorizeRequest(new Request(resource, { headers: { authorization: `Bearer ${tokens.access_token}` } }))).toMatchObject({ clientId: client, subject: "owner", scopes: ["mcp:admin"] });
  expect((await exchangeCode(client, code)).status).toBe(400);
});
test("resource gate rejects wrong issuer, audience, expiry, missing token, and insufficient scope", async () => {
  const key = await importPKCS8(privateKeyPem, "EdDSA");
  const issue = (claims: { issuer?: string; audience?: string; scope?: string; expiration?: number }) => new SignJWT({ client_id: "test-client", scope: claims.scope ?? "mcp:admin" })
    .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt" }).setIssuer(claims.issuer ?? issuer).setSubject("owner").setAudience(claims.audience ?? resource)
    .setIssuedAt().setNotBefore(Math.floor(Date.now() / 1000)).setJti(crypto.randomUUID()).setExpirationTime(claims.expiration ?? Math.floor(Date.now() / 1000) + 900).sign(key);
  for (const token of ["", await issue({ issuer: "https://wrong.example" }), await issue({ audience: issuer }), await issue({ expiration: Math.floor(Date.now() / 1000) - 10 })]) {
    const result = await service.authorizeRequest(new Request(resource, { headers: token ? { authorization: `Bearer ${token}` } : {} }));
    expect(result).toBeInstanceOf(Response); if (result instanceof Response) expect(result.status).toBe(401);
  }
  const result = await service.authorizeRequest(new Request(resource, { headers: { authorization: `Bearer ${await issue({ scope: "mcp:read" })}` } }));
  expect(result).toBeInstanceOf(Response); if (result instanceof Response) { expect(result.status).toBe(403); expect(result.headers.get("www-authenticate")).toContain("insufficient_scope"); }
});
test("revoking an older refresh token invalidates its whole family", async () => {
  const client = await registerClient(); const initial: Tokens = await (await exchangeCode(client, await authorize(client))).json();
  const first: Tokens = await (await rotate(client, initial.refresh_token)).json(); const second: Tokens = await (await rotate(client, first.refresh_token)).json();
  expect((await request("/oauth/revoke", form({ token: first.refresh_token, client_id: client }))).status).toBe(200);
  expect((await rotate(client, second.refresh_token)).status).toBe(400);
});
test("rotation changes the token and reuse revokes subsequent family tokens", async () => {
  const client = await registerClient(); const initial: Tokens = await (await exchangeCode(client, await authorize(client))).json();
  const response = await rotate(client, initial.refresh_token); expect(response.status).toBe(200); const next: Tokens = await response.json();
  expect(next.refresh_token).not.toBe(initial.refresh_token);
  expect((await rotate(client, initial.refresh_token)).status).toBe(400); expect((await rotate(client, next.refresh_token)).status).toBe(400);
});
