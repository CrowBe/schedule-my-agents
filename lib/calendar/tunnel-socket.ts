import { validatedAddress } from './callback-policy.ts';
import { signTunnel, TUNNEL_BYTES, TUNNEL_FRAME_BYTES } from './tunnel-protocol.ts';

export function tunnelEndpoint(origin: string) {
 const url = new URL(origin);
 if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.pathname !== '/') throw new Error('invalid_tunnel_origin');
 url.pathname = '/tunnel'; return url.href;
}

export async function openTunnelSocket(origin: string, secret: string, addresses: string[], signal: AbortSignal) {
 validatedAddress(addresses);
 const endpoint = tunnelEndpoint(origin);
 let lastError: unknown;
 for (const address of new Set(addresses)) {
  signal.throwIfAborted();
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = crypto.randomUUID().replaceAll('-', '');
  const signature = await signTunnel(secret, address, timestamp, nonce);
  const response = await fetch(endpoint, { method: 'GET', redirect: 'manual', signal, headers: {
   Upgrade: 'websocket', 'x-tunnel-address': address, 'x-tunnel-timestamp': timestamp,
   'x-tunnel-nonce': nonce, 'x-tunnel-signature': signature,
  } });
  if (response.status !== 101 || !response.webSocket) {
   void response.body?.cancel().catch(() => {});
   // Only a failed TCP dial may try the next already validated address.
   if (response.status === 502) { lastError = new Error('tunnel_connection_failed'); continue; }
   throw new Error('tunnel_upgrade_rejected');
  }
  const ws = response.webSocket;
  ws.binaryType = 'arraybuffer';
  let controller!: ReadableStreamDefaultController<Uint8Array>, ended = false, received = 0, sent = 0;
  const close = () => {
   if (ended) return;
   ended = true; signal.removeEventListener('abort', abort);
   try { ws.close(1000, 'done'); } catch { /* Already closed. */ }
  };
  const fail = () => { if (!ended) { controller.error(new Error('tunnel_closed')); close(); } };
  const abort = () => { if (!ended) { controller.error(signal.reason); close(); } };
  const readable = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel: close });
  ws.addEventListener('message', event => {
   if (ended) return;
   if (typeof event.data === 'string') { fail(); return; }
   const bytes = new Uint8Array(event.data); received += bytes.byteLength;
   if (bytes.byteLength > TUNNEL_FRAME_BYTES || received > TUNNEL_BYTES) { fail(); return; }
   controller.enqueue(bytes);
  });
  ws.addEventListener('error', fail);
  ws.addEventListener('close', () => { if (!ended) { controller.close(); close(); } });
  signal.addEventListener('abort', abort, { once: true });
  ws.accept();
  if (signal.aborted) abort();
  return { readable, writable: new WritableStream<Uint8Array>({
   write(bytes) {
    signal.throwIfAborted(); sent += bytes.byteLength;
    if (ended || sent > TUNNEL_BYTES) { close(); throw new Error('tunnel_byte_limit'); }
    for (let offset = 0; offset < bytes.byteLength; offset += TUNNEL_FRAME_BYTES) ws.send(bytes.slice(offset, offset + TUNNEL_FRAME_BYTES));
   }, close, abort: close,
  }), async close() { close(); } };
 }
 throw lastError ?? new Error('tunnel_connection_failed');
}
