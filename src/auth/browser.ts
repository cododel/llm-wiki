import { randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import type { SQL } from 'bun';
import { sha256 } from '../storage/database.ts';
import { authenticate, type AuthConfig } from './identity.ts';
import { requireCondition } from '../runtime/errors.ts';
const { createRemoteJWKSet, jwtVerify } = await import('jose');
const { z } = await import('zod');
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), id_token: z.string().optional() });

export interface BrowserConfig {
  origin: string; clientId: string; clientSecret: string; authorizationEndpoint: string; tokenEndpoint: string;
  jwksEndpoint: string; encryptionKey: string;
}
const equal = (a: string, b: string) => {
  const left=Buffer.from(a),right=Buffer.from(b);
  return left.length===right.length&&timingSafeEqual(left,right);
};
function cookie(request: Request, name: string): string | undefined {
  const values = request.headers.get('cookie')?.split(';').map(s => s.trim()).filter(s => s.startsWith(`${name}=`)) ?? [];
  return values.length === 1 ? values[0]!.slice(name.length + 1) : undefined;
}
export class BrowserAuth {
  private readonly key: Buffer;
  private readonly jwks;
  constructor(readonly db: SQL, readonly auth: AuthConfig, readonly config: BrowserConfig) {
    requireCondition(/^[0-9a-f]{64}$/.test(config.encryptionKey), 'invalid_config', 'Session encryption key must be 32 bytes encoded as hex');
    this.key = Buffer.from(config.encryptionKey, 'hex');
    this.jwks = createRemoteJWKSet(new URL(config.jwksEndpoint));
  }
  private encrypt(text: string): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
  }
  private decrypt(value: string): string {
    const bytes = Buffer.from(value, 'base64url'), decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0,12));
    decipher.setAuthTag(bytes.subarray(12,28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }
  async start(): Promise<Response> {
    const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
    await this.db`INSERT INTO browser_flows(state_hash,nonce,verifier) VALUES(${sha256(state)},${nonce},${this.encrypt(verifier)})`;
    const url = new URL(this.config.authorizationEndpoint);
    url.search = new URLSearchParams({ client_id: this.config.clientId, response_type: 'code', redirect_uri: `${this.config.origin}/auth/callback`,
      resource: this.auth.audience, scope: 'openid offline_access wiki:owner', state, nonce,
      code_challenge: Buffer.from(sha256(verifier), 'hex').toString('base64url'), code_challenge_method: 'S256' }).toString();
    return new Response(null, { status: 302, headers: { location: url.href, 'Set-Cookie': `__Host-wiki-flow=${state}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600` } });
  }
  private async token(parameters: Record<string, string>) {
    const response = await fetch(this.config.tokenEndpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}` },
      body: new URLSearchParams({ ...parameters, resource: this.auth.audience }),
    });
    requireCondition(response.ok, 'unauthorized', 'Browser authentication failed', 401);
    const parsed = tokenSchema.safeParse(await response.json());
    requireCondition(parsed.success, 'unauthorized', 'Invalid token response', 401);
    return parsed.data;
  }
  async callback(request: Request) {
    const url = new URL(request.url), state = url.searchParams.get('state'), code = url.searchParams.get('code'), bound = cookie(request, '__Host-wiki-flow');
    requireCondition(state && bound && equal(state,bound) && code && code.length < 8192, 'unauthorized', 'Invalid browser flow', 401);
    const rows = await this.db<{ nonce: string; verifier: string }[]>`DELETE FROM browser_flows WHERE state_hash=${sha256(state)} AND expires_at>now() RETURNING nonce,verifier`;
    requireCondition(rows.length, 'unauthorized', 'Browser flow expired', 401);
    const tokens = await this.token({ grant_type: 'authorization_code', code, code_verifier: this.decrypt(rows[0]!.verifier), redirect_uri: `${this.config.origin}/auth/callback` });
    requireCondition(tokens.id_token, 'unauthorized', 'ID token is required', 401);
    const verified = await jwtVerify(tokens.id_token, this.jwks, { issuer: this.auth.issuer, audience: this.config.clientId, algorithms: ['RS256'] });
    requireCondition(verified.payload.nonce === rows[0]!.nonce, 'unauthorized', 'ID token nonce mismatch', 401);
    const identity = await authenticate(new Request(this.config.origin, { headers: { authorization: `Bearer ${tokens.access_token}` } }), this.auth);
    requireCondition(identity.role === 'owner' && identity.client === this.config.clientId && identity.subject === verified.payload.sub,
      'forbidden', 'Owner browser identity required', 403);
    const session = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
    await this.db`INSERT INTO browser_sessions(id_hash,encrypted_tokens,csrf) VALUES(${sha256(session)},${this.encrypt(JSON.stringify(tokens))},${csrf})`;
    const headers = new Headers({ location: '/publications', 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', `__Host-wiki-session=${session}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800`);
    headers.append('Set-Cookie', '__Host-wiki-flow=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return new Response(null, { status: 302, headers });
  }
  async session(request: Request) {
    requireCondition(!request.headers.has('authorization'), 'forbidden', 'Agent tokens cannot confirm publication', 403);
    const session = cookie(request, '__Host-wiki-session');
    requireCondition(session && /^[A-Za-z0-9_-]{43}$/.test(session), 'unauthorized', 'Owner login required', 401);
    const rows = await this.db<{ encrypted_tokens: string; csrf: string }[]>`SELECT encrypted_tokens,csrf FROM browser_sessions WHERE id_hash=${sha256(session)} AND expires_at>now()`;
    requireCondition(rows.length, 'unauthorized', 'Owner session expired', 401);
    const tokens = tokenSchema.parse(JSON.parse(this.decrypt(rows[0]!.encrypted_tokens)));
    // Revalidate every protected browser request; expired/revoked tokens require a fresh login.
    const identity = await authenticate(new Request(this.config.origin, { headers: { authorization: `Bearer ${tokens.access_token}` } }), this.auth);
    requireCondition(identity.role === 'owner' && identity.client === this.config.clientId, 'forbidden', 'Owner browser identity required', 403);
    return { identity, csrf: rows[0]!.csrf };
  }
  validateCsrf(request: Request, expected: string, supplied: string) {
    requireCondition(request.method === 'POST' && request.headers.get('origin') === this.config.origin && equal(expected,supplied),
      'csrf', 'Invalid confirmation origin or CSRF token', 403);
  }
}
