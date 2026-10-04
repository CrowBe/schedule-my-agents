import { AppError } from './types.ts';
const encoder = new TextEncoder();
export const random = () => crypto.randomUUID();
export const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
export const unbase64 = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export async function digest(value: string) {
  return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
async function key(secret?: string) {
  if (!secret) throw new AppError(503, 'Token encryption is not configured.');
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = unbase64(secret); } catch { throw new AppError(503, 'Invalid token encryption configuration.'); }
  if (bytes.length !== 32) throw new AppError(503, 'Token encryption requires a 32-byte key.');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(value: string, secret: string | undefined, owner: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(owner) }, await key(secret), encoder.encode(value));
  return `${base64(iv)}.${base64(new Uint8Array(ciphertext))}`;
}
export async function open(value: string, secret: string | undefined, owner: string) {
  const [iv, ciphertext] = value.split('.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(iv), additionalData: encoder.encode(owner) }, await key(secret), unbase64(ciphertext));
  return new TextDecoder().decode(plain);
}
