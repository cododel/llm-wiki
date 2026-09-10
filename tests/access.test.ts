import { test, expect } from 'bun:test';
import { authenticate, type AuthConfig } from '../src/auth/identity.ts';
const config: AuthConfig = { issuer: 'https://auth.example.invalid', audience: 'https://wiki.example.invalid/mcp',
  introspectionEndpoint: 'https://auth.example.invalid/api/oidc/introspection', introspectionClient: 'wiki', introspectionSecret: 'synthetic-test-secret',
  grants: [{ subject: 'owner', client: 'personal', role: 'personal' }, { subject: 'factchecker', client: 'factchecker', role: 'factchecker' }] };
const claims = { active: true, iss: config.issuer, aud: [config.audience], exp: Date.now() / 1000 + 100,
  scope: 'wiki:read wiki:write', sub: 'owner', client_id: 'personal' };
const request = () => new Request('https://wiki.example.invalid/mcp', { headers: { authorization: 'Bearer opaque-test-token' } });
function provider(value: unknown): typeof fetch {
  return Object.assign(async () => Response.json(value), { preconnect: fetch.preconnect });
}
test('introspection runs for every request; no positive cache', async () => {
  let calls = 0;
  const fetcher = Object.assign(async () => { calls++; return Response.json(claims); }, { preconnect: fetch.preconnect });
  expect((await authenticate(request(), config, fetcher)).role).toBe('personal');
  await authenticate(request(), config, fetcher);
  expect(calls).toBe(2);
});
for (const [label, changes] of Object.entries({
  revoked: { active: false }, expired: { exp: 1 }, foreignAudience: { aud: ['https://other.invalid'] },
  absentAudience: { aud: undefined }, forgedSubject: { sub: 'other' }, wrongClient: { client_id: 'factchecker' },
  scopeEscalation: { scope: 'wiki:owner' }, foreignIssuer: { iss: 'https://other.invalid' },
})) test(`fail closed: ${label}`, async () => {
  await expect(authenticate(request(), config, provider({ ...claims, ...changes }))).rejects.toThrow();
});
test('unavailable provider denies access; identity headers grant nothing', async () => {
  const broken = Object.assign(async (): Promise<Response> => { throw new Error('unavailable'); }, { preconnect: fetch.preconnect });
  await expect(authenticate(request(), config, broken)).rejects.toMatchObject({ code: 'auth_unavailable' });
  expect((await authenticate(new Request('https://wiki.example.invalid', { headers: { 'X-Role': 'owner', 'X-User': 'owner' } }), config, broken)).role).toBe('public');
});
