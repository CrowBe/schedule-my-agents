// Transport-only protocol. No calendar identities or content belong in this module.
export const MAX_HORIZON = 366 * 86400_000;
export const LATE_WINDOW = 5 * 60_000;
export const CALLBACK_PATH = '/api/alarms/wake';
export type AlarmJob = { id: string; envelope: string; dueAt: number; expiresAt: number };
const encoder = new TextEncoder();
export function bytes(value: string) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
export function encoded(value: ArrayBuffer) { return btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
async function key(secret: string, usage: ('sign' | 'verify')[]) {
  const raw = bytes(secret);
  if (raw.length !== 32) throw new Error('Invalid alarm key.');
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, usage);
}
export async function mac(secret: string, value: string) {
  return encoded(await crypto.subtle.sign('HMAC', await key(secret, ['sign']), encoder.encode(value)));
}
export async function signedHeaders(secret: string, path: string, body: string, now = Date.now()) {
  const timestamp = String(now);
  return { 'content-type': 'application/json', 'x-alarm-time': timestamp,
    'x-alarm-signature': await mac(secret, `POST\n${path}\n${timestamp}\n${body}`) };
}
export async function verified(request: Request, body: string, secret: string | undefined, now: number) {
  const timestamp = request.headers.get('x-alarm-time'), signature = request.headers.get('x-alarm-signature');
  if (!secret || !timestamp || !/^\d{13}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > 60_000 || !signature || !/^[\w-]{43}$/.test(signature)) return false;
  try {
    const value = `POST\n${new URL(request.url).pathname}\n${timestamp}\n${body}`;
    return crypto.subtle.verify('HMAC', await key(secret, ['verify']), bytes(signature.replaceAll('-', '+').replaceAll('_', '/') + '='), encoder.encode(value));
  } catch { return false; }
}
export function parseJob(value: unknown): AlarmJob | null {
  if (!value || typeof value !== 'object') return null;
  const j = value as Partial<AlarmJob>;
  if (Object.keys(j).sort().join(',') !== 'dueAt,envelope,expiresAt,id' || typeof j.id !== 'string' || !/^[\w-]{43}$/.test(j.id) ||
    typeof j.envelope !== 'string' || j.envelope.length > 16384 || !/^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(j.envelope) ||
    !Number.isSafeInteger(j.dueAt) || !Number.isSafeInteger(j.expiresAt) || j.expiresAt !== j.dueAt! + LATE_WINDOW) return null;
  return j as AlarmJob;
}
export async function boundedBody(request: Request) {
  if (Number(request.headers.get('content-length')) > 20000) throw new Error('Request too large.');
  const reader = request.body?.getReader();
  if (!reader) return '';
  let size = 0; const chunks: Uint8Array[] = [];
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length;
    if (size > 20000) { await reader.cancel(); throw new Error('Request too large.'); } chunks.push(value); }
  const all = new Uint8Array(size); let offset = 0;
  for (const c of chunks) { all.set(c, offset); offset += c.length; }
  return new TextDecoder().decode(all);
}
