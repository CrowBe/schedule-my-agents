import { createServer } from 'node:http';
import { createConnection, isIP } from 'node:net';
import { WebSocketServer } from 'ws';
import { publicAddress } from '../lib/calendar/callback-policy.ts';
import { verifyTunnel, TUNNEL_LIFETIME_MS, TUNNEL_BYTES, TUNNEL_FRAME_BYTES } from '../lib/calendar/tunnel-protocol.ts';

// No HTTP callback, TLS termination, payload storage or content logging.
// TCP receives the authenticated literal address; it never resolves a hostname.
/** @param {{secret: string, dial?: (options: {host:string,port:number,autoSelectFamily:boolean}) => import('node:net').Socket, maxTunnels?: number, now?: () => number}} options */
export function createEgressServer({ secret, dial = options => createConnection(options), maxTunnels = 16, now = Date.now }) {
 if (!secret || Buffer.from(secret, 'base64').length !== 32 || Buffer.from(secret, 'base64').toString('base64') !== secret) throw new Error('invalid_tunnel_key');
 const used = new Map(), active = new Set(), live = new Set(); let pending = 0;
 const server = createServer((req, res) => {
  res.writeHead(req.method === 'GET' && req.url === '/health' ? 204 : 404, { 'Cache-Control': 'no-store' }); res.end();
 });
 server.headersTimeout = 5000; server.requestTimeout = 10_000; server.maxHeadersCount = 16;
 const sockets = new WebSocketServer({ noServer: true, maxPayload: TUNNEL_FRAME_BYTES, perMessageDeflate: false });
 server.on('upgrade', (req, client, head) => { void upgrade(req, client, head).catch(() => client.destroy()); });
 async function upgrade(req, client, head) {
  const reject = status => { if (!client.destroyed) client.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
  const address = req.headers['x-tunnel-address'], timestamp = req.headers['x-tunnel-timestamp'];
  const nonce = req.headers['x-tunnel-nonce'], signature = req.headers['x-tunnel-signature'];
  if (req.method !== 'GET' || req.url !== '/tunnel' || req.headers.origin ||
      [address, timestamp, nonce, signature].some(value => typeof value !== 'string') || !isIP(address) || !publicAddress(address)) { reject(403); return; }
  const instant = now();
  if (!await verifyTunnel(secret, address, timestamp, nonce, signature, instant)) { reject(403); return; }
  if (client.destroyed) return;
  for (const [id, until] of used) if (until < instant) used.delete(id);
  if (used.has(nonce)) { reject(403); return; }
  if (active.size + pending >= maxTunnels || used.size >= 4096) { reject(429); return; }
  used.set(nonce, Number(timestamp) * 1000 + TUNNEL_LIFETIME_MS);
  pending++;
  let target;
  try { target = dial({ host: address, port: 443, autoSelectFamily: false }); }
  catch { pending--; reject(502); return; }
  live.add(target);
  let ws, settled = false, connecting = true, sent = 0, received = 0;
  const finish = () => {
   if (settled) return; settled = true; clearTimeout(timer); if (connecting) pending--;
   active.delete(target); live.delete(target); target.destroy(); if (ws) ws.terminate();
  };
  const timer = setTimeout(() => { if (!ws) reject(504); finish(); }, TUNNEL_LIFETIME_MS);
  client.once('close', finish);
  target.on('error', () => { if (!ws) reject(502); finish(); });
  target.on('close', finish);
  target.once('connect', () => {
   if (settled || client.destroyed) { finish(); return; }
   target.pause();
   sockets.handleUpgrade(req, client, head, connection => {
    ws = connection; connecting = false; pending--; active.add(target);
    ws.on('error', finish); ws.on('close', finish);
    ws.on('message', (data, binary) => {
     sent += data.length;
     if (!binary || sent > TUNNEL_BYTES || data.length > TUNNEL_FRAME_BYTES) { finish(); return; }
     if (!target.write(data)) { ws.pause(); target.once('drain', () => { if (!settled) ws.resume(); }); }
    });
    target.on('data', bytes => {
     received += bytes.length;
     if (received > TUNNEL_BYTES) { finish(); return; }
     target.pause();
     ws.send(bytes, { binary: true }, error => { if (error) finish(); else if (!settled) target.resume(); });
    });
    target.resume();
   });
  });
 }
 return { server, async close() {
  for (const target of live) target.destroy();
  sockets.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
 } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
 const app = createEgressServer({ secret: process.env.CALLBACK_TUNNEL_KEY });
 app.server.listen(Number(process.env.PORT || 8080), process.env.HOST || '127.0.0.1');
 for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void app.close(); });
}
