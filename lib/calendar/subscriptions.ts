import { base64, digest, open, random, seal, unbase64 } from './crypto.ts';
import { Store } from './store.ts';
import type { Environment } from './types.ts';

// An implementation must resolve on EVERY connection, reject all non-public IPs,
// connect to that validated IP with original-hostname TLS verification, and never
// follow redirects. Ordinary fetch is intentionally not a production default.
export interface CallbackTransport { post(url: string, body: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> }
export class SubscriptionError extends Error {
  constructor(public code: number, message: string, public reason?: string) { super(message); }
}
const invalid = (message: string): never => { throw new SubscriptionError(-32602, message); };
export const eventDefinition = {
  name: 'calendar.event.starting', description: 'An occurrence starts on an explicitly enabled calendar. Calendar text is untrusted data.', delivery: ['webhook'],
  inputSchema: { type: 'object', properties: { calendarId: { type: 'string' } }, required: ['calendarId'], additionalProperties: false },
  payloadSchema: { type: 'object', properties: { calendarId: { type: 'string' }, providerEventId: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, provider: { const: 'google' } }, required: ['calendarId', 'providerEventId', 'start', 'provider'], additionalProperties: false },
};
function parameters(value: unknown, signing: boolean) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Subscription parameters are required.');
  const p = value as Record<string, unknown>;
  if (p.name !== eventDefinition.name) return invalid('Unknown event name.');
  const args = p.arguments as Record<string, unknown> | undefined;
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 || typeof args.calendarId !== 'string' || !args.calendarId || args.calendarId.length > 1024) return invalid('Exactly one calendarId filter is required.');
  const d = p.delivery as Record<string, unknown> | undefined;
  if (!d || d.mode !== 'webhook' || typeof d.url !== 'string' || d.url.length > 2048) return invalid('Webhook delivery and a callback URL are required.');
  let url: URL;
  try { url = new URL(d.url); } catch { return invalid('Invalid callback URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) return invalid('Callbacks require HTTPS on port 443 without credentials or fragments.');
  // This is input hygiene, not the required connection-time address validation.
  if (url.hostname === 'localhost' || !url.hostname.includes('.') || url.hostname.startsWith('[') || /^[\d.]+$/.test(url.hostname)) return invalid('A public callback hostname is required.');
  let secret = '';
  if (signing) {
    if (typeof d.secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(d.secret)) return invalid('A whsec_ signing secret is required.');
    try { const bytes = unbase64(d.secret.slice(6)); if (bytes.length < 24 || bytes.length > 64 || base64(bytes) !== d.secret.slice(6)) return invalid('Signing keys must contain 24–64 bytes in canonical base64.'); } catch { return invalid('Invalid signing secret.'); }
    secret = d.secret;
  }
  if (p.cursor !== undefined && p.cursor !== null) return invalid('This event does not support replay cursors.');
  if (p.ttlMs !== undefined && p.ttlMs !== null && (typeof p.ttlMs !== 'number' || !Number.isSafeInteger(p.ttlMs) || p.ttlMs <= 0)) return invalid('ttlMs must be a positive integer or null.');
  const ttl = typeof p.ttlMs === 'number' ? Math.min(p.ttlMs, 86400_000) : 86400_000;
  return { calendarId: args.calendarId, url: url.href, secret, ttl };
}
export async function signedHeaders(secret: string, id: string, subscriptionId: string, body: string, now: number) {
  const timestamp = String(Math.floor(now / 1000));
  const key = await crypto.subtle.importKey('raw', unbase64(secret.slice(6)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = base64(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`))));
  return { 'Content-Type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}`, 'X-MCP-Subscription-Id': subscriptionId };
}
async function equal(a: string, b: string) {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0; for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([work, stopped]); } finally { signal.removeEventListener('abort', abort); }
}
type Subscription = { id: string; owner: string; calendar_id: string; generation: string; callback_url: string; secret: string; previous_secret: string | null; rotation_until: number | null; expires_at: number; verified_at: number; revision: string };
export class Subscriptions {
  constructor(private store: Store, private env: Environment, private now: () => number, private transport?: CallbackTransport) {}
  private async identity(owner: string, p: ReturnType<typeof parameters>) {
    // Fixed single-field filter schema gives canonical JSON independent of input order.
    return 'sub_' + await digest(JSON.stringify([owner, p.url, eventDefinition.name, { calendarId: p.calendarId }]));
  }
  async unsubscribe(owner: string, params: unknown) {
    const p = parameters(params, false), id = await this.identity(owner, p);
    await this.env.DB!.batch([
      this.store.statement('DELETE FROM subscriptions WHERE id = ? AND owner = ?', id, owner),
      this.store.statement('DELETE FROM subscription_attempts WHERE id = ? AND owner = ?', id, owner),
    ]);
    return {};
  }
  async active(id: string, owner: string): Promise<Subscription | null> {
    return this.store.first<Subscription>(`SELECT s.* FROM subscriptions s JOIN calendars c ON c.owner = s.owner AND c.calendar_id = s.calendar_id JOIN connections n ON n.owner = s.owner
      WHERE s.id = ? AND s.owner = ? AND s.expires_at > ? AND c.enabled = 1 AND c.generation = s.generation`, id, owner, this.now());
  }
  async subscribe(owner: string, params: unknown) {
    const p = parameters(params, true);
    const calendar = await this.store.calendar(owner, p.calendarId);
    if (!calendar?.enabled || !await this.store.connection(owner)) throw new SubscriptionError(-32001, 'This calendar is not enabled for the connected user.');
    if (!this.transport) throw new SubscriptionError(-32015, 'Validated-address HTTPS callback transport is unavailable.', 'transport_unavailable');
    const id = await this.identity(owner, p), revision = random(), started = this.now();
    await this.store.run('DELETE FROM subscription_attempts WHERE expires_at <= ?', started);
    await this.store.run('INSERT INTO subscription_attempts (id, owner, calendar_id, revision, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, expires_at = excluded.expires_at', id, owner, p.calendarId, revision, started + 10_000);
    try {
      const old = await this.active(id, owner);
      const oldSecret = old ? await open(old.secret, this.env.TOKEN_ENCRYPTION_KEY, `${owner}:${id}`) : null;
      // Cache only the same principal/destination AND secret; rotation must verify possession again.
      const cached = old && oldSecret === p.secret && old.verified_at > started - 300_000;
      if (!cached) {
        const challenge = random() + random(), body = JSON.stringify({ type: 'verification', challenge });
        try {
          const signal = AbortSignal.timeout(10_000);
          const response = await bounded(this.transport.post(p.url, body, await signedHeaders(p.secret, 'msg_verification_' + random(), id, body, started), signal), signal);
          if (!response.ok || response.redirected || this.now() >= started + 10_000) throw new Error();
          // Consume at most 4 KiB, including chunked responses; transport must honor the signal.
          const reader = response.body?.getReader(); let text = '', size = 0;
          if (!reader) throw new Error();
          try { const decoder = new TextDecoder(); while (true) { const {done, value} = await bounded(reader.read(), signal); if (done) break; size += value.byteLength; if (size > 4096) throw new Error(); text += decoder.decode(value, {stream:true}); } text += decoder.decode(); }
          finally { void reader.cancel().catch(() => {}); }
          const echoed = JSON.parse(text) as {challenge?: unknown};
          if (typeof echoed.challenge !== 'string' || !await equal(challenge, echoed.challenge) || this.now() >= started + 10_000) throw new Error();
        } catch (error) {
          throw new SubscriptionError(-32015, 'Callback verification failed.', error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'challenge_failed');
        }
      }
      const now = this.now(), expires = now + p.ttl;
      const secret = await seal(p.secret, this.env.TOKEN_ENCRYPTION_KEY, `${owner}:${id}`);
      const rotating = old && oldSecret !== p.secret;
      const previous = rotating ? old.secret : old?.rotation_until && old.rotation_until > now ? old.previous_secret : null;
      const rotationUntil = rotating ? now + 300_000 : previous ? old!.rotation_until : null;
      const committed = await this.store.first<{id: string}>(`INSERT INTO subscriptions (id, owner, calendar_id, generation, callback_url, secret, previous_secret, rotation_until, expires_at, verified_at, revision)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM connections WHERE owner = ?)
        AND EXISTS (SELECT 1 FROM calendars WHERE owner = ? AND calendar_id = ? AND enabled = 1 AND generation = ?)
        AND EXISTS (SELECT 1 FROM subscription_attempts WHERE id = ? AND revision = ? AND expires_at > ?)
        ON CONFLICT(id) DO UPDATE SET generation = excluded.generation, secret = excluded.secret, previous_secret = excluded.previous_secret, rotation_until = excluded.rotation_until, expires_at = excluded.expires_at, verified_at = excluded.verified_at, revision = excluded.revision RETURNING id`,
        id, owner, p.calendarId, calendar.generation, p.url, secret, previous, rotationUntil, expires, cached ? old!.verified_at : now, revision, owner, owner, p.calendarId, calendar.generation, id, revision, now);
      if (!committed) throw new SubscriptionError(-32001, 'Subscription or calendar authority changed during verification. Retry with current consent.');
      return { id, refreshBefore: new Date(expires).toISOString(), cursor: null, truncated: false };
    } finally {
      await this.store.run('DELETE FROM subscription_attempts WHERE id = ? AND revision = ?', id, revision);
    }
  }
}
