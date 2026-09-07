// Single-owner OAuth authorization server and resource verifier extracted from
// the source wiki. Public clients, PKCE S256, explicit consent, rotating refresh
// families, exact issuer/resource binding. No multi-user or write scope is added.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { Database } from "bun:sqlite";
const { SignJWT, exportJWK, importPKCS8, importSPKI, jwtVerify } = await import("jose");
import type { OAuthHttpGate, OAuthRequestAuth } from "./http-server.ts";
const CODE_TTL_MS = 5 * 60_000;
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_BODY_BYTES = 64 * 1024;
const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
export type OAuthServiceConfig = {
  issuer: string; resource: string; dbPath: string; ownerUsername: string; ownerPasswordHash: string;
  privateKeyPem: string; publicKeyPem: string; requiredScopes: string[];
  maxClients?: number; maxPendingAuthorizations?: number; maxRateBuckets?: number;
};
export type OAuthService = OAuthHttpGate & { close(): void };
type ClientRow = { client_id: string; client_name: string | null; redirect_uris: string; grant_types: string };
type AuthorizationParams = { clientId: string; redirectUri: string; resource: string; scopes: string[]; state: string; codeChallenge: string };
type PendingRow = { request_id: string; params_json: string; csrf_hash: string; expires_at: number };
type CodeRow = { code_hash: string; client_id: string; subject: string; redirect_uri: string; resource: string; scopes: string;
  code_challenge: string; expires_at: number; consumed_at: number | null };
type RefreshRow = { token_hash: string; family_id: string; client_id: string; subject: string; resource: string; scopes: string;
  expires_at: number; revoked_at: number | null };
type RateBucket = { count: number; resetAt: number };
function canonicalHttpsUrl(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new Error(`${label} must be a canonical HTTPS URL`);
  return url.toString().replace(/\/$/, "");
}
const sha256 = (value: string): string => createHash("sha256").update(value).digest("base64url");
const opaque = (prefix = ""): string => prefix + randomBytes(32).toString("base64url");
function noStore(headers: HeadersInit = {}): Headers {
  const result = new Headers(headers); result.set("Cache-Control", "no-store"); result.set("Pragma", "no-cache"); return result;
}
function json(data: unknown, status = 200, headers: HeadersInit = {}): Response { return Response.json(data, { status, headers: noStore(headers) }); }
function oauthError(error: string, description: string, status = 400): Response { return json({ error, error_description: description }, status); }
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
function parseCookies(request: Request): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("="); if (index > 0) result.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return result;
}
function requestIp(request: Request): string { return (request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local").slice(0, 128); }
async function readBody(request: Request): Promise<string> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new Error("request body too large");
  const body = await request.text(); if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error("request body too large"); return body;
}
function validRedirectUri(value: string): boolean {
  if (value.includes("*")) return false;
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return ["127.0.0.1", "[::1]", "::1", "localhost"].includes(url.hostname);
  } catch { return false; }
}
export function createOAuthService(input: OAuthServiceConfig): OAuthService {
  const issuer = canonicalHttpsUrl(input.issuer, "issuer");
  const resource = canonicalHttpsUrl(input.resource, "resource");
  const requiredScopes = [...new Set(input.requiredScopes)].sort();
  const maxClients = input.maxClients ?? 1000;
  const maxPendingAuthorizations = input.maxPendingAuthorizations ?? 1000;
  const maxRateBuckets = input.maxRateBuckets ?? 10_000;
  if (!Number.isInteger(maxClients) || maxClients < 1 || maxClients > 100_000) throw new Error("maxClients must be 1..100000");
  if (!Number.isInteger(maxPendingAuthorizations) || maxPendingAuthorizations < 1 || maxPendingAuthorizations > 100_000) throw new Error("maxPendingAuthorizations must be 1..100000");
  if (!Number.isInteger(maxRateBuckets) || maxRateBuckets < 1 || maxRateBuckets > 1_000_000) throw new Error("maxRateBuckets must be 1..1000000");
  if (!requiredScopes.length || requiredScopes.some((scope) => !/^[A-Za-z0-9:._-]+$/.test(scope))) throw new Error("requiredScopes must contain valid scopes");
  const resourcePath = new URL(resource).pathname.replace(/^\//, "");
  const protectedMetadataPath = `/.well-known/oauth-protected-resource/${resourcePath}`;
  const protectedMetadataUrl = `${issuer}${protectedMetadataPath}`;
  const db = new Database(input.dbPath, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY, client_name TEXT, redirect_uris TEXT NOT NULL, grant_types TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_pending (
      request_id TEXT PRIMARY KEY, params_json TEXT NOT NULL, csrf_hash TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_sessions (
      token_hash TEXT PRIMARY KEY, subject TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, subject TEXT NOT NULL, redirect_uri TEXT NOT NULL,
      resource TEXT NOT NULL, scopes TEXT NOT NULL, code_challenge TEXT NOT NULL, expires_at INTEGER NOT NULL,
      consumed_at INTEGER, FOREIGN KEY(client_id) REFERENCES oauth_clients(client_id)
    );
    CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
      token_hash TEXT PRIMARY KEY, family_id TEXT NOT NULL, client_id TEXT NOT NULL, subject TEXT NOT NULL,
      resource TEXT NOT NULL, scopes TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER,
      replaced_by_hash TEXT, created_at INTEGER NOT NULL, FOREIGN KEY(client_id) REFERENCES oauth_clients(client_id)
    );
    CREATE INDEX IF NOT EXISTS oauth_refresh_family_idx ON oauth_refresh_tokens(family_id);
  `);
  for (const path of [input.dbPath, `${input.dbPath}-wal`, `${input.dbPath}-shm`]) if (existsSync(path)) chmodSync(path, 0o600);
  const cleanupExpired = () => {
    const now = Date.now();
    db.transaction(() => {
      db.query("DELETE FROM oauth_pending WHERE expires_at <= ?").run(now);
      db.query("DELETE FROM oauth_sessions WHERE expires_at <= ?").run(now);
      db.query("DELETE FROM oauth_codes WHERE expires_at <= ?").run(now);
      db.query("DELETE FROM oauth_refresh_tokens WHERE expires_at <= ?").run(now);
    })();
  };
  cleanupExpired();
  const privateKeyPromise = importPKCS8(input.privateKeyPem, "EdDSA");
  const publicKeyPromise = importSPKI(input.publicKeyPem, "EdDSA");
  const jwkPromise = publicKeyPromise.then(async (key) => ({ ...(await exportJWK(key)), use: "sig", alg: "EdDSA", kid: "wiki-oauth-1" }));
  const rateBuckets = new Map<string, RateBucket>();
  function rateLimited(request: Request, route: string, limit: number, windowMs: number): boolean {
    const now = Date.now(); const key = `${route}:${requestIp(request)}`; let bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (bucket) rateBuckets.delete(key);
      if (rateBuckets.size >= maxRateBuckets) for (const [existingKey, existing] of rateBuckets) if (existing.resetAt <= now) rateBuckets.delete(existingKey);
      if (rateBuckets.size >= maxRateBuckets) return true;
      bucket = { count: 0, resetAt: now + windowMs }; rateBuckets.set(key, bucket);
    }
    bucket.count += 1; return bucket.count > limit;
  }
  function challenge(status: 401 | 403, error?: "invalid_token" | "insufficient_scope"): Response {
    const fields = [`resource_metadata="${protectedMetadataUrl}"`, `scope="${requiredScopes.join(" ")}"`];
    if (error) fields.push(`error="${error}"`);
    return new Response(status === 401 ? "Unauthorized" : "Forbidden", { status, headers: noStore({ "WWW-Authenticate": `Bearer ${fields.join(", ")}` }) });
  }
  function currentSubject(request: Request): string | undefined {
    const raw = parseCookies(request).get("__Host-wiki_oauth_session"); if (!raw) return undefined;
    const row = db.query("SELECT subject, expires_at FROM oauth_sessions WHERE token_hash = ?").get(sha256(raw)) as { subject: string; expires_at: number } | null;
    return !row || row.expires_at <= Date.now() ? undefined : row.subject;
  }
  function getClient(clientId: string): ClientRow | null {
    return db.query("SELECT client_id, client_name, redirect_uris, grant_types FROM oauth_clients WHERE client_id = ?").get(clientId) as ClientRow | null;
  }
  function validateAuthorization(url: URL): AuthorizationParams | Response {
    const clientId = url.searchParams.get("client_id") ?? ""; const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const client = getClient(clientId);
    if (!client || !(JSON.parse(client.redirect_uris) as string[]).includes(redirectUri)) return oauthError("invalid_request", "unknown client or redirect_uri");
    if (url.searchParams.get("response_type") !== "code") return oauthError("unsupported_response_type", "only code is supported");
    if (url.searchParams.get("resource") !== resource) return oauthError("invalid_target", "resource must match the MCP resource exactly");
    if (url.searchParams.get("code_challenge_method") !== "S256") return oauthError("invalid_request", "PKCE S256 is required");
    const codeChallenge = url.searchParams.get("code_challenge") ?? "";
    if (!PKCE_CHALLENGE.test(codeChallenge)) return oauthError("invalid_request", "invalid code_challenge");
    const requested = (url.searchParams.get("scope") || requiredScopes.join(" ")).split(/\s+/).filter(Boolean);
    if (!requested.length || requested.some((scope) => !requiredScopes.includes(scope))) return oauthError("invalid_scope", "unsupported scope");
    const state = url.searchParams.get("state") ?? "";
    if (state.length > 2048) return oauthError("invalid_request", "state is too long");
    return { clientId, redirectUri, resource, scopes: [...new Set(requested)].sort(), state, codeChallenge };
  }
  function loginPage(requestId: string, csrf: string, error = ""): Response {
    const message = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Wiki MCP sign in</title><style>body{font:16px system-ui;background:#111827;color:#e5e7eb;display:grid;place-items:center;min-height:100vh;margin:0}form{width:min(360px,calc(100% - 40px));padding:24px;background:#1f2937;border:1px solid #374151;border-radius:12px}label,input,button{display:block;width:100%;box-sizing:border-box}input,button{margin:8px 0 16px;padding:12px;border-radius:8px;border:1px solid #4b5563}button{background:#2563eb;color:white;font-weight:700;cursor:pointer}.error{color:#fca5a5}</style></head><body><form method="post" action="/login"><h1>Wiki MCP</h1>${message}<input type="hidden" name="request_id" value="${escapeHtml(requestId)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form></body></html>`, {
      status: error ? 401 : 200, headers: noStore({ "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff" }),
    });
  }
  function consentPage(requestId: string, csrf: string, params: AuthorizationParams): Response {
    const clientName = getClient(params.clientId)?.client_name || params.clientId;
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Authorize Wiki MCP</title><style>body{font:16px system-ui;background:#111827;color:#e5e7eb;display:grid;place-items:center;min-height:100vh;margin:0}form{width:min(480px,calc(100% - 40px));padding:24px;background:#1f2937;border:1px solid #374151;border-radius:12px}.value{overflow-wrap:anywhere;padding:10px;background:#111827;border-radius:8px}button{padding:12px 18px;border:0;border-radius:8px;font-weight:700;cursor:pointer}.approve{background:#2563eb;color:white}.deny{background:#374151;color:#e5e7eb;margin-left:8px}</style></head><body><form method="post" action="/oauth/approve"><h1>Authorize Wiki MCP</h1><p><strong>${escapeHtml(clientName)}</strong> requests access.</p><p>Redirect URI</p><p class="value">${escapeHtml(params.redirectUri)}</p><p>Resource</p><p class="value">${escapeHtml(params.resource)}</p><p>Scopes</p><p class="value">${escapeHtml(params.scopes.join(" "))}</p><input type="hidden" name="request_id" value="${escapeHtml(requestId)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="approve" name="decision" value="approve" type="submit">Authorize</button><button class="deny" name="decision" value="deny" type="submit">Deny</button></form></body></html>`, {
      status: 200, headers: noStore({ "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" }),
    });
  }
  function issueCode(params: AuthorizationParams, subject: string, requestId?: string): Response {
    const rawCode = opaque("mcp_code_"); const now = Date.now();
    db.transaction(() => {
      db.query(`INSERT INTO oauth_codes (code_hash, client_id, subject, redirect_uri, resource, scopes, code_challenge, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(sha256(rawCode), params.clientId, subject, params.redirectUri, params.resource, JSON.stringify(params.scopes), params.codeChallenge, now + CODE_TTL_MS);
      if (requestId) db.query("DELETE FROM oauth_pending WHERE request_id = ?").run(requestId);
    })();
    const callback = new URL(params.redirectUri); callback.searchParams.set("code", rawCode);
    if (params.state) callback.searchParams.set("state", params.state); callback.searchParams.set("iss", issuer);
    return new Response(null, { status: 302, headers: noStore({ Location: callback.toString() }) });
  }
  async function handleRegister(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    if (rateLimited(request, "register", 20, 60 * 60_000)) return oauthError("temporarily_unavailable", "rate limit exceeded", 429);
    try {
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      const redirects = body.redirect_uris; const grants = body.grant_types ?? ["authorization_code"];
      const responses = body.response_types ?? ["code"]; const method = body.token_endpoint_auth_method ?? "none";
      if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 10 || redirects.some((uri) => typeof uri !== "string" || !validRedirectUri(uri))) return oauthError("invalid_redirect_uri", "redirect_uris must be exact HTTPS or loopback HTTP URLs");
      if (!Array.isArray(grants) || grants.some((grant) => grant !== "authorization_code" && grant !== "refresh_token") || !grants.includes("authorization_code")) return oauthError("invalid_client_metadata", "unsupported grant_types");
      if (!Array.isArray(responses) || responses.length !== 1 || responses[0] !== "code" || method !== "none") return oauthError("invalid_client_metadata", "only code with token_endpoint_auth_method=none is supported");
      const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 200) : null;
      const clientCount = db.query("SELECT COUNT(*) AS count FROM oauth_clients").get() as { count: number };
      if (clientCount.count >= maxClients) return oauthError("temporarily_unavailable", "client registration capacity reached", 429);
      const clientId = opaque("mcp_client_");
      db.query("INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(clientId, clientName, JSON.stringify(redirects), JSON.stringify([...new Set(grants)]), Date.now());
      return json({ client_id: clientId, client_name: clientName, redirect_uris: redirects, grant_types: [...new Set(grants)], response_types: ["code"], token_endpoint_auth_method: "none" }, 201);
    } catch (error) { return oauthError("invalid_client_metadata", error instanceof Error ? error.message : "invalid request"); }
  }
  async function handleAuthorize(request: Request): Promise<Response> {
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
    if (rateLimited(request, "authorize", 120, 15 * 60_000)) return oauthError("temporarily_unavailable", "rate limit exceeded", 429);
    const url = new URL(request.url); const requestId = url.searchParams.get("request_id");
    if (requestId) {
      const pending = db.query("SELECT request_id, params_json, csrf_hash, expires_at FROM oauth_pending WHERE request_id = ?").get(requestId) as PendingRow | null;
      if (!pending || pending.expires_at <= Date.now()) return oauthError("invalid_request", "authorization request expired");
      const subject = currentSubject(request);
      if (!subject) return oauthError("login_required", "login session missing", 401);
      const csrf = opaque("csrf_");
      db.query("UPDATE oauth_pending SET csrf_hash = ? WHERE request_id = ?").run(sha256(csrf), requestId);
      return consentPage(requestId, csrf, JSON.parse(pending.params_json));
    }
    const validated = validateAuthorization(url); if (validated instanceof Response) return validated;
    cleanupExpired();
    const pendingCount = db.query("SELECT COUNT(*) AS count FROM oauth_pending").get() as { count: number };
    if (pendingCount.count >= maxPendingAuthorizations) return oauthError("temporarily_unavailable", "authorization request capacity reached", 429);
    const subject = currentSubject(request); const pendingId = opaque("req_"); const csrf = opaque("csrf_");
    db.query("INSERT INTO oauth_pending (request_id, params_json, csrf_hash, expires_at) VALUES (?, ?, ?, ?)")
      .run(pendingId, JSON.stringify(validated), sha256(csrf), Date.now() + CODE_TTL_MS);
    return subject ? consentPage(pendingId, csrf, validated) : loginPage(pendingId, csrf);
  }
  async function handleLogin(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    if (rateLimited(request, "login", 10, 15 * 60_000)) return new Response("Too Many Requests", { status: 429, headers: noStore({ "Retry-After": "900" }) });
    try {
      const form = new URLSearchParams(await readBody(request)); const requestId = form.get("request_id") ?? ""; const csrf = form.get("csrf") ?? "";
      const pending = db.query("SELECT request_id, params_json, csrf_hash, expires_at FROM oauth_pending WHERE request_id = ?").get(requestId) as PendingRow | null;
      if (!pending || pending.expires_at <= Date.now() || sha256(csrf) !== pending.csrf_hash) return oauthError("invalid_request", "invalid or expired login request");
      const username = form.get("username") ?? ""; const password = form.get("password") ?? "";
      const valid = username === input.ownerUsername && await Bun.password.verify(password, input.ownerPasswordHash);
      if (!valid) return loginPage(requestId, csrf, "Invalid username or password");
      const session = opaque("session_");
      db.query("INSERT INTO oauth_sessions (token_hash, subject, expires_at) VALUES (?, ?, ?)").run(sha256(session), "owner", Date.now() + SESSION_TTL_MS);
      return new Response(null, { status: 303, headers: noStore({ Location: `/oauth/authorize?request_id=${encodeURIComponent(requestId)}`,
        "Set-Cookie": `__Host-wiki_oauth_session=${session}; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Lax` }) });
    } catch (error) { return oauthError("invalid_request", error instanceof Error ? error.message : "invalid request"); }
  }
  async function handleApprove(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    if (rateLimited(request, "approve", 30, 15 * 60_000)) return new Response("Too Many Requests", { status: 429, headers: noStore({ "Retry-After": "900" }) });
    try {
      const subject = currentSubject(request); if (!subject) return oauthError("login_required", "login session missing", 401);
      const form = new URLSearchParams(await readBody(request)); const requestId = form.get("request_id") ?? ""; const csrf = form.get("csrf") ?? "";
      const pending = db.query("SELECT request_id, params_json, csrf_hash, expires_at FROM oauth_pending WHERE request_id = ?").get(requestId) as PendingRow | null;
      if (!pending || pending.expires_at <= Date.now() || sha256(csrf) !== pending.csrf_hash) return oauthError("invalid_request", "invalid or expired authorization request");
      const params = JSON.parse(pending.params_json) as AuthorizationParams;
      if (form.get("decision") !== "approve") {
        db.query("DELETE FROM oauth_pending WHERE request_id = ?").run(requestId);
        const callback = new URL(params.redirectUri); callback.searchParams.set("error", "access_denied");
        if (params.state) callback.searchParams.set("state", params.state); callback.searchParams.set("iss", issuer);
        return new Response(null, { status: 302, headers: noStore({ Location: callback.toString() }) });
      }
      return issueCode(params, subject, requestId);
    } catch (error) { return oauthError("invalid_request", error instanceof Error ? error.message : "invalid request"); }
  }
  async function signAccessToken(clientId: string, subject: string, scopes: string[]): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ client_id: clientId, scope: scopes.join(" ") }).setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: "wiki-oauth-1" })
      .setIssuer(issuer).setSubject(subject).setAudience(resource).setIssuedAt(now).setNotBefore(now)
      .setJti(crypto.randomUUID()).setExpirationTime(now + ACCESS_TTL_SECONDS).sign(await privateKeyPromise);
  }
  async function exchangeAuthorizationCode(form: URLSearchParams): Promise<Response> {
    const rawCode = form.get("code") ?? "";
    const row = db.query(`SELECT code_hash, client_id, subject, redirect_uri, resource, scopes, code_challenge, expires_at, consumed_at FROM oauth_codes WHERE code_hash = ?`).get(sha256(rawCode)) as CodeRow | null;
    const codeVerifier = form.get("code_verifier") ?? "";
    if (!row || row.consumed_at || row.expires_at <= Date.now() || row.client_id !== form.get("client_id") || row.redirect_uri !== form.get("redirect_uri") ||
      row.resource !== form.get("resource") || !PKCE_VERIFIER.test(codeVerifier) || sha256(codeVerifier) !== row.code_challenge) return oauthError("invalid_grant", "authorization code is invalid, expired, consumed, or PKCE verification failed");
    const scopes = JSON.parse(row.scopes) as string[]; const accessToken = await signAccessToken(row.client_id, row.subject, scopes);
    const refreshToken = opaque("mcp_refresh_"); const refreshHash = sha256(refreshToken); const familyId = crypto.randomUUID(); const now = Date.now();
    const commit = db.transaction(() => {
      const consumed = db.query("UPDATE oauth_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL").run(now, row.code_hash);
      if (consumed.changes !== 1) throw new Error("authorization code already consumed");
      db.query(`INSERT INTO oauth_refresh_tokens (token_hash, family_id, client_id, subject, resource, scopes, expires_at, revoked_at, replaced_by_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`)
        .run(refreshHash, familyId, row.client_id, row.subject, row.resource, row.scopes, now + REFRESH_TTL_MS, now);
    });
    try { commit(); } catch { return oauthError("invalid_grant", "authorization code already consumed"); }
    return json({ access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_SECONDS, refresh_token: refreshToken, scope: scopes.join(" ") });
  }
  async function exchangeRefreshToken(form: URLSearchParams): Promise<Response> {
    const raw = form.get("refresh_token") ?? "";
    const row = db.query(`SELECT token_hash, family_id, client_id, subject, resource, scopes, expires_at, revoked_at FROM oauth_refresh_tokens WHERE token_hash = ?`).get(sha256(raw)) as RefreshRow | null;
    if (!row) return oauthError("invalid_grant", "refresh token is invalid");
    if (row.revoked_at) {
      db.query("UPDATE oauth_refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE family_id = ?").run(Date.now(), row.family_id);
      return oauthError("invalid_grant", "refresh token reuse detected");
    }
    if (row.expires_at <= Date.now() || row.client_id !== form.get("client_id") || row.resource !== form.get("resource")) return oauthError("invalid_grant", "refresh token is invalid or expired");
    const scopes = JSON.parse(row.scopes) as string[]; const accessToken = await signAccessToken(row.client_id, row.subject, scopes);
    const next = opaque("mcp_refresh_"); const nextHash = sha256(next); const now = Date.now();
    const rotate = db.transaction(() => {
      const revoked = db.query("UPDATE oauth_refresh_tokens SET revoked_at = ?, replaced_by_hash = ? WHERE token_hash = ? AND revoked_at IS NULL").run(now, nextHash, row.token_hash);
      if (revoked.changes !== 1) throw new Error("refresh token already used");
      db.query(`INSERT INTO oauth_refresh_tokens (token_hash, family_id, client_id, subject, resource, scopes, expires_at, revoked_at, replaced_by_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`)
        .run(nextHash, row.family_id, row.client_id, row.subject, row.resource, row.scopes, now + REFRESH_TTL_MS, now);
    });
    try { rotate(); } catch {
      db.query("UPDATE oauth_refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE family_id = ?").run(Date.now(), row.family_id);
      return oauthError("invalid_grant", "refresh token reuse detected");
    }
    return json({ access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_SECONDS, refresh_token: next, scope: scopes.join(" ") });
  }
  async function handleToken(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    if (rateLimited(request, "token", 60, 15 * 60_000)) return oauthError("temporarily_unavailable", "rate limit exceeded", 429);
    try {
      const form = new URLSearchParams(await readBody(request)); const grant = form.get("grant_type");
      if (grant === "authorization_code") return exchangeAuthorizationCode(form);
      if (grant === "refresh_token") return exchangeRefreshToken(form);
      return oauthError("unsupported_grant_type", "only authorization_code and refresh_token are supported");
    } catch (error) { return oauthError("invalid_request", error instanceof Error ? error.message : "invalid request"); }
  }
  async function handleRevoke(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    try {
      const form = new URLSearchParams(await readBody(request)); const token = form.get("token") ?? "";
      const row = db.query("SELECT family_id, client_id FROM oauth_refresh_tokens WHERE token_hash = ?").get(sha256(token)) as { family_id: string; client_id: string } | null;
      const suppliedClientId = form.get("client_id");
      if (row && (!suppliedClientId || suppliedClientId === row.client_id)) db.query("UPDATE oauth_refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE family_id = ?").run(Date.now(), row.family_id);
      return new Response(null, { status: 200, headers: noStore() });
    } catch { return new Response(null, { status: 200, headers: noStore() }); }
  }
  async function authorizeRequest(request: Request): Promise<OAuthRequestAuth | Response> {
    const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
    if (!match) return challenge(401);
    try {
      const { payload } = await jwtVerify(match[1], await publicKeyPromise, { issuer, audience: resource, algorithms: ["EdDSA"], typ: "at+jwt",
        requiredClaims: ["sub", "client_id", "scope", "exp", "iat", "nbf", "jti"] });
      if (typeof payload.sub !== "string" || typeof payload.client_id !== "string" || typeof payload.scope !== "string" || typeof payload.exp !== "number") return challenge(401, "invalid_token");
      const scopes = payload.scope.split(/\s+/).filter(Boolean);
      if (requiredScopes.some((scope) => !scopes.includes(scope))) return challenge(403, "insufficient_scope");
      return { clientId: payload.client_id, subject: payload.sub, scopes, expiresAt: payload.exp };
    } catch { return challenge(401, "invalid_token"); }
  }
  async function handleRoute(request: Request): Promise<Response | undefined> {
    const path = new URL(request.url).pathname;
    if (path === "/.well-known/oauth-protected-resource" || path === protectedMetadataPath) return json({ resource, authorization_servers: [issuer], scopes_supported: requiredScopes, bearer_methods_supported: ["header"] });
    if (path === "/.well-known/oauth-authorization-server") return json({ issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`, revocation_endpoint: `${issuer}/oauth/revoke`, jwks_uri: `${issuer}/.well-known/jwks.json`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"], scopes_supported: requiredScopes, authorization_response_iss_parameter_supported: true });
    if (path === "/.well-known/jwks.json") return json({ keys: [await jwkPromise] });
    if (path === "/oauth/register") return handleRegister(request);
    if (path === "/oauth/authorize") return handleAuthorize(request);
    if (path === "/login") return handleLogin(request);
    if (path === "/oauth/approve") return handleApprove(request);
    if (path === "/oauth/token") return handleToken(request);
    if (path === "/oauth/revoke") return handleRevoke(request);
    return undefined;
  }
  return { handleRoute, authorizeRequest, close: () => db.close(false) };
}
