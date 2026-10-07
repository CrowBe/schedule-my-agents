import { publicAddress } from './callback-policy.ts';

// The relay receives only a literal address and TLS records. Authentication
// binds that exact address to a short-lived, single-use request.
export const TUNNEL_LIFETIME_MS = 10_000;
export const TUNNEL_BYTES = 384 * 1024;
export const TUNNEL_FRAME_BYTES = 64 * 1024;

function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
 const bytes = Uint8Array.from(atob(secret), c => c.charCodeAt(0));
 if (bytes.length !== 32 || btoa(String.fromCharCode(...bytes)) !== secret) throw new Error('invalid_tunnel_key');
 return bytes;
}
function message(address: string, timestamp: string, nonce: string) {
 if (!publicAddress(address) || !/^\d{10}$/.test(timestamp) || !/^[a-f0-9]{32}$/.test(nonce)) throw new Error('invalid_tunnel_request');
 return new TextEncoder().encode(`callback-tunnel-v1\n${address}\n443\n${timestamp}\n${nonce}`);
}
export async function signTunnel(secret: string, address: string, timestamp: string, nonce: string) {
 const key = await crypto.subtle.importKey('raw', secretBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
 const signature = await crypto.subtle.sign('HMAC', key, message(address, timestamp, nonce));
 return btoa(String.fromCharCode(...new Uint8Array(signature)));
}
export async function verifyTunnel(secret: string, address: string, timestamp: string, nonce: string, signature: string, now: number) {
 try {
  if (Math.abs(now - Number(timestamp) * 1000) > TUNNEL_LIFETIME_MS) return false;
  const bytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
  if (bytes.length !== 32 || btoa(String.fromCharCode(...bytes)) !== signature) return false;
  const key = await crypto.subtle.importKey('raw', secretBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return await crypto.subtle.verify('HMAC', key, bytes, message(address, timestamp, nonce));
 } catch { return false; }
}
