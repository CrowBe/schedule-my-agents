import type { Environment } from './types.ts';

export type AuthEnvironment = Environment & {
  OWNER_ID?: string;
  ADMIN_SECRET?: string;
  MCP_AUTH_TOKEN?: string;
  SESSION_SECRET?: string;
  TRUST_PROXY_AUTH_HEADER?: string;
};
export type AuthMode = 'self_hosted' | 'proxy' | 'unconfigured';

export const SESSION_COOKIE = 'sma_session';
export const SESSION_TTL_MS = 24 * 60 * 60_000;
const OWNER_HEADER = 'x-authenticated-owner';
// Provider push and alarm wakes carry their own channel/HMAC authority, never owner identity.
const PUBLIC_PATHS = [/^\/api\/google\/webhook$/, /^\/api\/providers\/[a-z][a-z0-9_-]{0,63}\/webhook$/, /^\/api\/alarms\/wake$/];
const encoder = new TextEncoder();
const noStore = { 'Cache-Control': 'no-store' };
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(value, { status, headers: { ...noStore, ...headers } });

export function authMode(env: AuthEnvironment): AuthMode {
  if (env.ADMIN_SECRET) return 'self_hosted';
  return env.TRUST_PROXY_AUTH_HEADER === 'true' ? 'proxy' : 'unconfigured';
}
const configuredOwner = (env: AuthEnvironment) => env.OWNER_ID || 'owner';
const proxyOwner = (request: Request, env: AuthEnvironment) => env.TRUST_PROXY_AUTH_HEADER === 'true' ? request.headers.get(OWNER_HEADER) || null : null;

// Digest both sides first so comparison time is independent of length and content.
async function secretEquals(given: string, expected: string) {
  const [a, b] = await Promise.all([given, expected].map(async value => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))));
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
function bearer(request: Request) {
  const match = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/);
  return match ? match[1] : null;
}
function cookie(request: Request, name: string) {
  for (const part of request.headers.get('cookie')?.split(';') ?? []) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const unbase64url = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));

async function sessionKey(env: AuthEnvironment) {
  const material = env.SESSION_SECRET ?? env.TOKEN_ENCRYPTION_KEY ?? env.ADMIN_SECRET;
  if (!material) throw new Error('Session signing is not configured.');
  const base = await crypto.subtle.importKey('raw', encoder.encode(material), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: encoder.encode('schedule-my-agents/session/v1') },
    base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
}

export async function createSessionCookie(owner: string, env: AuthEnvironment, now: number, secure: boolean) {
  const payload = base64url(encoder.encode(JSON.stringify({ owner, exp: now + SESSION_TTL_MS })));
  const signature = base64url(new Uint8Array(await crypto.subtle.sign('HMAC', await sessionKey(env), encoder.encode(payload))));
  return `${SESSION_COOKIE}=${payload}.${signature}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`;
}
async function sessionOwner(request: Request, env: AuthEnvironment, now: number) {
  const [payload, signature, extra] = cookie(request, SESSION_COOKIE)?.split('.') ?? [];
  if (!payload || !signature || extra !== undefined) return null;
  try {
    if (!await crypto.subtle.verify('HMAC', await sessionKey(env), unbase64url(signature), encoder.encode(payload))) return null;
    const session = JSON.parse(new TextDecoder().decode(unbase64url(payload))) as { owner?: unknown; exp?: unknown };
    // A changed OWNER_ID invalidates existing sessions.
    return typeof session.exp === 'number' && session.exp > now && session.owner === configuredOwner(env) ? session.owner : null;
  } catch {
    return null;
  }
}

/** Owner for setup/admin `/api/*` routes. MCP_AUTH_TOKEN is never accepted here. */
export async function authenticateApi(request: Request, env: AuthEnvironment, now: number): Promise<string | null> {
  if (authMode(env) !== 'self_hosted') return proxyOwner(request, env);
  const token = bearer(request);
  if (token) return await secretEquals(token, env.ADMIN_SECRET!) ? configuredOwner(env) : null;
  return sessionOwner(request, env, now);
}

/** Owner for `POST /mcp`. Admin sessions and ADMIN_SECRET never authorize an MCP host. */
export async function authenticateMcp(request: Request, env: AuthEnvironment): Promise<string | null> {
  if (!env.MCP_AUTH_TOKEN) return proxyOwner(request, env);
  // A shared value would let an MCP host administer calendars; refuse it.
  if (env.ADMIN_SECRET && env.MCP_AUTH_TOKEN === env.ADMIN_SECRET) return null;
  const token = bearer(request);
  return token && await secretEquals(token, env.MCP_AUTH_TOKEN) ? configuredOwner(env) : null;
}

/** HTTPS origin, or a loopback HTTP origin for local preview. */
export function siteOrigin(env: AuthEnvironment) {
  if (!env.SITE_ORIGIN) throw new Error('Site origin is not configured.');
  const url = new URL(env.SITE_ORIGIN);
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !loopback) || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('Site origin must be an HTTPS origin.');
  return url.origin;
}
const insecureLoopback = (origin: string) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);

/** Handles `/api/auth/*`. Returns null for any other path. */
export async function handleAuthRoute(request: Request, env: AuthEnvironment, now: number, origin: () => string): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/auth/')) return null;
  const mode = authMode(env);
  if (path === '/api/auth/session' && request.method === 'GET') {
    const owner = await authenticateApi(request, env, now);
    return json({ authenticated: Boolean(owner), mode, ...(owner ? { owner } : {}) });
  }
  if ((path === '/api/auth/login' || path === '/api/auth/logout') && request.method === 'POST') {
    let expected: string;
    try { expected = origin(); } catch { return json({ error: 'Site origin is not configured.' }, 503); }
    if (request.headers.get('origin') !== expected) return json({ error: 'Request origin is not allowed.' }, 403);
    const secure = !insecureLoopback(expected);
    if (path === '/api/auth/logout') {
      return json({ authenticated: false }, 200, { 'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}` });
    }
    if (mode !== 'self_hosted') return json({ error: 'Admin sign-in is not configured on this server.' }, 503);
    let secret: unknown;
    try { secret = (await request.json() as { secret?: unknown }).secret; } catch { /* Rejected below. */ }
    if (typeof secret !== 'string' || secret.length > 1024 || !await secretEquals(secret, env.ADMIN_SECRET!)) return json({ error: 'Invalid admin secret.' }, 401);
    return json({ authenticated: true }, 200, { 'Set-Cookie': await createSessionCookie(configuredOwner(env), env, now, secure) });
  }
  return json({ error: 'Route not found.' }, 404);
}

/**
 * The single owner-identity boundary in front of CalendarService. Caller-supplied
 * owner headers are always stripped; only an authenticated owner is forwarded.
 */
export async function authorizeRequest(request: Request, env: AuthEnvironment, now: number): Promise<Response | Request> {
  const path = new URL(request.url).pathname;
  const auth = await handleAuthRoute(request, env, now, () => siteOrigin(env));
  if (auth) return auth;
  const headers = new Headers(request.headers);
  headers.delete(OWNER_HEADER);
  if (!PUBLIC_PATHS.some(pattern => pattern.test(path))) {
    const owner = path === '/mcp' ? await authenticateMcp(request, env) : await authenticateApi(request, env, now);
    if (!owner) return json({ error: 'Authentication is required.' }, 401, path === '/mcp' ? { 'WWW-Authenticate': 'Bearer' } : {});
    headers.set(OWNER_HEADER, owner);
  }
  return new Request(request, { headers });
}
