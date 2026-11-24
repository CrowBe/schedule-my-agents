import test from 'node:test';
import assert from 'node:assert/strict';
import { authMode, authenticateApi, authenticateMcp, authorizeRequest, createSessionCookie, handleAuthRoute, SESSION_COOKIE, type AuthEnvironment } from '../lib/calendar/auth.ts';

const ORIGIN = 'https://bridge.example';
const NOW = Date.parse('2026-11-25T12:00:00Z');
const ADMIN = 'admin-secret-value-0123456789';
const MCP = 'mcp-token-value-9876543210';
const selfHosted: AuthEnvironment = { SITE_ORIGIN: ORIGIN, ADMIN_SECRET: ADMIN, MCP_AUTH_TOKEN: MCP, OWNER_ID: 'ben', TOKEN_ENCRYPTION_KEY: btoa('k'.repeat(32)) };
const origin = () => ORIGIN;
const req = (path: string, init: RequestInit = {}) => new Request(ORIGIN + path, init);
const sessionValue = (setCookie: string) => setCookie.split(';')[0];
async function login(env = selfHosted, secret = ADMIN, requestOrigin = ORIGIN) {
  return (await handleAuthRoute(req('/api/auth/login', { method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ secret }) }), env, NOW, origin))!;
}
const withCookie = (cookie: string) => ({ headers: { cookie } });

test('unconfigured server fails closed even when x-authenticated-owner is sent', async () => {
  const env: AuthEnvironment = { SITE_ORIGIN: ORIGIN };
  assert.equal(authMode(env), 'unconfigured');
  const spoofed = { headers: { 'x-authenticated-owner': 'attacker' } };
  assert.equal(await authenticateApi(req('/api/status', spoofed), env, NOW), null);
  assert.equal(await authenticateMcp(req('/mcp', spoofed), env), null);
  for (const path of ['/api/status', '/mcp']) {
    const result = await authorizeRequest(req(path, { method: path === '/mcp' ? 'POST' : 'GET', ...spoofed }), env, NOW);
    assert.ok(result instanceof Response);
    assert.equal(result.status, 401);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
  const session = await (await handleAuthRoute(req('/api/auth/session', spoofed), env, NOW, origin))!.json();
  assert.deepEqual(session, { authenticated: false, mode: 'unconfigured' });
});

test('TRUST_PROXY_AUTH_HEADER=true is the only way to trust x-authenticated-owner', async () => {
  const env: AuthEnvironment = { SITE_ORIGIN: ORIGIN, TRUST_PROXY_AUTH_HEADER: 'true' };
  assert.equal(authMode(env), 'proxy');
  const headers = { 'x-authenticated-owner': 'proxy-user' };
  assert.equal(await authenticateApi(req('/api/status', { headers }), env, NOW), 'proxy-user');
  assert.equal(await authenticateMcp(req('/mcp', { headers }), env), 'proxy-user');
  assert.equal(await authenticateApi(req('/api/status'), env, NOW), null);
  assert.equal(await authenticateApi(req('/api/status', { headers }), { ...env, TRUST_PROXY_AUTH_HEADER: 'TRUE' }, NOW), null);
  // A self-hosted admin secret takes precedence over proxy trust on /api/*.
  assert.equal(await authenticateApi(req('/api/status', { headers }), { ...env, ADMIN_SECRET: ADMIN }, NOW), null);
});

test('self-hosted login sets a signed HttpOnly session that authorizes /api/*', async () => {
  const response = await login();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: true });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const setCookie = response.headers.get('set-cookie')!;
  assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=[^;]+; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400; Secure$`));
  assert.ok(!setCookie.includes(ADMIN) && !setCookie.includes(MCP));
  const cookie = sessionValue(setCookie);
  assert.equal(await authenticateApi(req('/api/status', withCookie(cookie)), selfHosted, NOW), 'ben');
  const session = await (await handleAuthRoute(req('/api/auth/session', withCookie(`other=1; ${cookie}`)), selfHosted, NOW, origin))!.json();
  assert.deepEqual(session, { authenticated: true, mode: 'self_hosted', owner: 'ben' });
  const anonymous = await (await handleAuthRoute(req('/api/auth/session'), selfHosted, NOW, origin))!.json();
  assert.deepEqual(anonymous, { authenticated: false, mode: 'self_hosted' });
});

test('loopback HTTP origins get a non-Secure cookie', async () => {
  const local = 'http://127.0.0.1:8787';
  const env = { ...selfHosted, SITE_ORIGIN: local };
  const response = (await handleAuthRoute(new Request(local + '/api/auth/login', { method: 'POST', headers: { origin: local }, body: JSON.stringify({ secret: ADMIN }) }), env, NOW, () => local))!;
  assert.equal(response.status, 200);
  assert.ok(!response.headers.get('set-cookie')!.includes('Secure'));
});

test('tampered, expired, foreign-owner, and differently-signed sessions are rejected', async () => {
  const cookie = sessionValue((await login()).headers.get('set-cookie')!);
  const [name, token] = cookie.split('=');
  const [payload, signature] = token.split('.');
  const forged = btoa(JSON.stringify({ owner: 'ben', exp: NOW + 10 * 86400_000 })).replaceAll('=', '');
  for (const bad of [`${name}=${forged}.${signature}`, `${name}=${payload}.${signature.slice(0, -2)}AA`, `${name}=${payload}`, `${name}=${payload}.${signature}.x`, `${name}=garbage`]) {
    assert.equal(await authenticateApi(req('/api/status', withCookie(bad)), selfHosted, NOW), null, bad);
  }
  assert.equal(await authenticateApi(req('/api/status', withCookie(cookie)), selfHosted, NOW + 86400_000), null, 'expired');
  assert.equal(await authenticateApi(req('/api/status', withCookie(cookie)), { ...selfHosted, OWNER_ID: 'someone-else' }, NOW), null, 'owner changed');
  assert.equal(await authenticateApi(req('/api/status', withCookie(cookie)), { ...selfHosted, SESSION_SECRET: 'rotated' }, NOW), null, 'key rotated');
  const otherKey = sessionValue(await createSessionCookie('ben', { ...selfHosted, TOKEN_ENCRYPTION_KEY: btoa('z'.repeat(32)) }, NOW, true));
  assert.equal(await authenticateApi(req('/api/status', withCookie(otherKey)), selfHosted, NOW), null, 'foreign signer');
});

test('wrong secret, malformed bodies, and cross-origin login or logout are rejected', async () => {
  assert.equal((await login(selfHosted, 'wrong')).status, 401);
  assert.equal((await login(selfHosted, MCP)).status, 401);
  assert.equal((await login(selfHosted, ADMIN, 'https://evil.example')).status, 403);
  const malformed = (await handleAuthRoute(req('/api/auth/login', { method: 'POST', headers: { origin: ORIGIN }, body: '{' }), selfHosted, NOW, origin))!;
  assert.equal(malformed.status, 401);
  assert.equal(malformed.headers.get('set-cookie'), null);
  const crossLogout = (await handleAuthRoute(req('/api/auth/logout', { method: 'POST', headers: { origin: 'https://evil.example' } }), selfHosted, NOW, origin))!;
  assert.equal(crossLogout.status, 403);
  assert.equal((await login({ SITE_ORIGIN: ORIGIN })).status, 503, 'no admin secret configured');
  assert.equal((await handleAuthRoute(req('/api/auth/unknown'), selfHosted, NOW, origin))!.status, 404);
  assert.equal(await handleAuthRoute(req('/api/status'), selfHosted, NOW, origin), null);
});

test('logout clears the session cookie', async () => {
  const response = (await handleAuthRoute(req('/api/auth/logout', { method: 'POST', headers: { origin: ORIGIN } }), selfHosted, NOW, origin))!;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: false });
  assert.match(response.headers.get('set-cookie')!, new RegExp(`^${SESSION_COOKIE}=; .*Max-Age=0`));
});

test('admin and MCP authority are strictly separated', async () => {
  const cookie = sessionValue((await login()).headers.get('set-cookie')!);
  const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
  // MCP token works on /mcp only.
  assert.equal(await authenticateMcp(req('/mcp', bearer(MCP)), selfHosted), 'ben');
  assert.equal(await authenticateApi(req('/api/status', bearer(MCP)), selfHosted, NOW), null);
  // Admin bearer and session work on /api/* only.
  assert.equal(await authenticateApi(req('/api/status', bearer(ADMIN)), selfHosted, NOW), 'ben');
  assert.equal(await authenticateMcp(req('/mcp', bearer(ADMIN)), selfHosted), null);
  assert.equal(await authenticateMcp(req('/mcp', withCookie(cookie)), selfHosted), null);
  assert.equal(await authenticateMcp(req('/mcp', { headers: { 'x-authenticated-owner': 'ben' } }), { ...selfHosted, TRUST_PROXY_AUTH_HEADER: 'true' }), null);
  assert.equal(await authenticateMcp(req('/mcp', bearer('wrong')), selfHosted), null);
  assert.equal(await authenticateMcp(req('/mcp'), selfHosted), null);
  // Reusing one value for both collapses the separation, so MCP fails closed.
  assert.equal(await authenticateMcp(req('/mcp', bearer(ADMIN)), { ...selfHosted, MCP_AUTH_TOKEN: ADMIN }), null);
  // Self-hosted admin without an MCP token leaves /mcp closed.
  assert.equal(await authenticateMcp(req('/mcp', bearer(ADMIN)), { ...selfHosted, MCP_AUTH_TOKEN: undefined }), null);
});

test('the request gate strips spoofed owners and forwards only the authenticated owner', async () => {
  const forward = async (path: string, init: RequestInit) => {
    const result = await authorizeRequest(req(path, init), selfHosted, NOW);
    return result;
  };
  const spoof = { 'x-authenticated-owner': 'attacker' };
  const mcp = await forward('/mcp', { method: 'POST', headers: { ...spoof, authorization: `Bearer ${MCP}` }, body: '{"jsonrpc":"2.0"}' });
  assert.ok(mcp instanceof Request);
  assert.equal(mcp.headers.get('x-authenticated-owner'), 'ben');
  assert.equal(await mcp.text(), '{"jsonrpc":"2.0"}');
  const rejected = await forward('/api/calendars/enable', { method: 'POST', headers: { ...spoof, authorization: `Bearer ${MCP}`, origin: ORIGIN }, body: '{}' });
  assert.ok(rejected instanceof Response);
  assert.equal(rejected.status, 401);
  const admin = await forward('/api/status', { headers: { ...spoof, authorization: `Bearer ${ADMIN}` } });
  assert.ok(admin instanceof Request);
  assert.equal(admin.headers.get('x-authenticated-owner'), 'ben');
  // Provider push and alarm wakes carry their own authority and never an owner.
  for (const path of ['/api/google/webhook', '/api/providers/opaque/webhook', '/api/alarms/wake']) {
    const result = await forward(path, { method: 'POST', headers: spoof, body: '' });
    assert.ok(result instanceof Request, path);
    assert.equal(result.headers.get('x-authenticated-owner'), null, path);
  }
  const login = await forward('/api/auth/login', { method: 'POST', headers: { origin: ORIGIN }, body: JSON.stringify({ secret: ADMIN }) });
  assert.ok(login instanceof Response);
  assert.equal(login.status, 200);
});
