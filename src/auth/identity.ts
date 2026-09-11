import { requireCondition } from '../runtime/errors.ts';

export type Role = 'personal' | 'factchecker' | 'owner' | 'public';
export interface Identity { actor: string; subject: string; client: string; role: Role; capabilities?: ('manage_locks')[] }
export interface Grant { subject: string; client: string; role: Exclude<Role, 'public'>; capabilities?: ('manage_locks')[] }
export const anonymous: Identity = { actor: 'public', subject: '', client: '', role: 'public' };
export function requireRole(identity: Identity, ...roles: Role[]): void {
  requireCondition(roles.includes(identity.role), 'forbidden', 'Operation not permitted', 403);
}

export interface AuthConfig {
  issuer: string;
  audience: string;
  introspectionEndpoint: string;
  introspectionClient: string;
  introspectionSecret: string;
  grants: Grant[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function authenticate(request: Request, config: AuthConfig, fetcher: typeof fetch = fetch): Promise<Identity> {
  const header = request.headers.get('authorization');
  if (!header) return anonymous;
  requireCondition(/^Bearer [^\s]{1,8192}$/.test(header), 'unauthorized', 'Invalid authorization', 401);
  let value: unknown;
  try {
    const response = await fetcher(config.introspectionEndpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${config.introspectionClient}:${config.introspectionSecret}`).toString('base64')}` },
      body: new URLSearchParams({ token: header.slice(7), token_type_hint: 'access_token' }),
    });
    requireCondition(response.ok, 'auth_unavailable', 'Authentication unavailable', 503);
    value = await response.json();
  } catch {
    requireCondition(false, 'auth_unavailable', 'Authentication unavailable', 503);
  }
  requireCondition(isObject(value), 'unauthorized', 'Invalid authorization', 401);
  const aud = typeof value.aud === 'string' ? [value.aud] : value.aud;
  requireCondition(value.active === true && value.iss === config.issuer && typeof value.exp === 'number' && value.exp > Date.now() / 1000
    && Array.isArray(aud) && aud.includes(config.audience) && typeof value.sub === 'string' && typeof value.client_id === 'string'
    && typeof value.scope === 'string', 'unauthorized', 'Invalid authorization', 401);
  const grants = config.grants.filter(grant => grant.subject === value.sub && grant.client === value.client_id);
  requireCondition(grants.length === 1, 'forbidden', 'Identity has no unique local grant', 403);
  const grant = grants[0]!;
  const scopes = new Set(value.scope.split(' '));
  const required = grant.role === 'personal' ? ['wiki:read', 'wiki:write'] : grant.role === 'factchecker' ? ['wiki:read', 'wiki:factcheck'] : ['wiki:owner'];
  requireCondition(required.every(scope => scopes.has(scope)), 'forbidden', 'Required scope missing', 403);
  return { actor: JSON.stringify([config.issuer, grant.subject, grant.client]), subject: grant.subject, client: grant.client, role: grant.role, capabilities:grant.capabilities??[] };
}
