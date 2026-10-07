import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { createServer } from 'node:tls';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createEgressServer } from '../egress/server.mjs';
import { signTunnel, verifyTunnel, TUNNEL_BYTES } from '../lib/calendar/tunnel-protocol.ts';
import { tunnelEndpoint } from '../lib/calendar/tunnel-socket.ts';

const WebSocket = createRequire(import.meta.url)('../egress/node_modules/ws');
const secret = randomBytes(32).toString('base64'), address = '104.18.10.1';
const timestamp = () => String(Math.floor(Date.now() / 1000));
const nonce = () => randomBytes(16).toString('hex');
async function auth(ip = address, time = timestamp(), id = nonce()) {
 return { 'x-tunnel-address': ip, 'x-tunnel-timestamp': time, 'x-tunnel-nonce': id,
  'x-tunnel-signature': await signTunnel(secret, ip, time, id) };
}
async function listening(server: ReturnType<typeof createEgressServer>['server']) {
 await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
 return (server.address() as { port: number }).port;
}
async function rejected(url: string, headers: Record<string, string>) {
 return new Promise<number>((resolve, reject) => {
  const socket = new WebSocket(url, { headers }); socket.on('error', () => {});
  socket.on('unexpected-response', (_req: unknown, response: { statusCode: number; resume(): void }) => { response.resume(); socket.terminate(); resolve(response.statusCode); });
  socket.on('open', () => { socket.terminate(); reject(new Error('Unexpected upgrade')); });
 });
}

test('tunnel authentication binds the literal public address, nonce and fresh timestamp', async () => {
 const time = timestamp(), id = nonce(), signature = await signTunnel(secret, address, time, id);
 assert.equal(await verifyTunnel(secret, address, time, id, signature, Date.now()), true);
 for (const [ip, stamp, requestId, sig] of [
  ['8.8.8.8', time, id, signature], [address, time, nonce(), signature],
  [address, String(Number(time) - 11), id, signature], [address, time, id, 'invalid'],
  ['127.0.0.1', time, id, signature], ['::ffff:127.0.0.1', time, id, signature],
  ['receiver.example', time, id, signature], ['1.1.1.1:443', time, id, signature],
 ]) assert.equal(await verifyTunnel(secret, ip, stamp, requestId, sig, Date.now()), false);
 assert.throws(() => tunnelEndpoint('http://relay.example'));
 assert.throws(() => tunnelEndpoint('https://user@relay.example'));
 assert.throws(() => tunnelEndpoint('https://relay.example/elsewhere'));
 assert.equal(tunnelEndpoint('https://relay.example'), 'https://relay.example/tunnel');
});

test('relay rejects unauthenticated, private, stale, replayed and browser requests before opening TCP', async () => {
 let dials = 0;
 const relay = createEgressServer({ secret, dial: () => { dials++; throw new Error('No dial permitted'); } });
 const port = await listening(relay.server), url = `ws://127.0.0.1:${port}/tunnel`;
 try {
  assert.equal(await rejected(url, {}), 403);
  assert.equal(await rejected(url, { ...await auth(), 'x-tunnel-address': '127.0.0.1' }), 403);
  assert.equal(await rejected(url, await auth(address, String(Number(timestamp()) - 11))), 403);
  assert.equal(await rejected(url, { ...await auth(), Origin: 'https://browser.example' }), 403);
  assert.equal(await rejected(url.replace('/tunnel', '/other'), await auth()), 403);
  assert.equal(dials, 0);
 } finally { await relay.close(); }
});

test('actual Workers Go TLS crosses the ciphertext relay with pinned IP and original-hostname verification', async t => {
 const directory = mkdtempSync(join(tmpdir(), 'callback-tunnel-'));
 execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
 const cert = readFileSync(join(directory, 'cert.pem'), 'utf8'), key = readFileSync(join(directory, 'key.pem'), 'utf8');
 const plaintext: string[] = []; let mode = 'echo', securePeers = 0, relayReceived = 0;
 const targets = new Set<import('node:tls').TLSSocket>();
 const peer = createServer({ cert, key }, socket => {
  securePeers++;
  targets.add(socket); socket.on('close', () => targets.delete(socket)); socket.on('error', () => {});
  let request = Buffer.alloc(0);
  socket.on('data', bytes => {
   request = Buffer.concat([request, bytes]);
   const text = request.toString(), split = text.indexOf('\r\n\r\n');
   if (split < 0 || request.length < split + 4 + Number(/Content-Length: (\d+)/i.exec(text)?.[1] || 0)) return;
   plaintext.push(text);
   if (mode === 'stall') return;
   if (mode === 'large' || mode === 'body-stall') {
    socket.write('HTTP/1.1 200 OK\r\nContent-Length: 999999\r\n\r\n');
    if (mode === 'large') socket.write('x'.repeat(5000)); return;
   }
   const status = mode === 'redirect' ? 302 : mode === 'terminal' ? 410 : 200;
   socket.write(`HTTP/1.1 ${status} Result\r\nContent-Length: 25\r\nConnection: keep-alive\r\n\r\n{"challenge":"synthetic"}`);
  });
 });
 peer.on('tlsClientError', () => {});
 await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
 const peerPort = (peer.address() as { port: number }).port;
 const dials: { host: string; port: number }[] = [];
 const relay = createEgressServer({ secret, dial: (options: { host: string; port: number }) => {
  dials.push(options); // Test-only mapping after production address validation.
  const socket = createConnection({ host: '127.0.0.1', port: peerPort });
  socket.on('data', bytes => { relayReceived += bytes.length; });
  return socket;
 } });
 const relayPort = await listening(relay.server);
 t.after(async () => {
  await relay.close(); for (const target of targets) target.destroy();
  await new Promise<void>(resolve => peer.close(() => resolve()));
 });
 const result = await build({ stdin: { contents: `
  import {createPinnedCallbackTransport} from './lib/calendar/callback-transport.ts';
  import {openTunnelSocket} from './lib/calendar/tunnel-socket.ts';
  const realFetch = globalThis.fetch;
  // Only the outer relay endpoint is remapped to local HTTP by this fixture.
  globalThis.fetch = (url, init) => realFetch(String(url).replace('https://relay.example', 'http://127.0.0.1:${relayPort}'), init);
  export default {async fetch(request, env) {
   const params = new URL(request.url).searchParams;
   const transport = createPinnedCallbackTransport((ips, signal) => openTunnelSocket('https://relay.example', env.KEY, ips, signal),
    async () => params.has('private') ? ['${address}','127.0.0.1'] : ['${address}'], env.CERT);
   try {
    const response = await transport.post('https://' + (params.get('host') || 'localhost') + '/private-path',
     '{"type":"verification","challenge":"synthetic"}', {'Content-Type':'application/json','webhook-signature':'v1,private-signature'},
     AbortSignal.timeout(params.has('abort') ? 100 : 4000), params.has('status') ? 'status' : 'body');
    return Response.json({status:response.status,body:await response.text()});
   } catch(error) { return Response.json({failed:true}, {status:502}); }
  }};`, resolveDir: process.cwd(), sourcefile: 'tunnel-worker.ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  external: ['cloudflare:sockets'], plugins: [{ name: 'tls-assets', setup(build) {
   build.onResolve({ filter: /tls\.wasm$/ }, () => ({ path: './tls.wasm', external: true }));
   build.onResolve({ filter: /roots\.pem\?raw$/ }, () => ({ path: 'roots', namespace: 'test-roots' }));
   build.onLoad({ filter: /.*/, namespace: 'test-roots' }, () => ({ contents: `export default ${JSON.stringify(cert)}`, loader: 'js' }));
  } }] });
 const mf = new Miniflare({ modules: [ { type: 'ESModule', path: 'main.js', contents: result.outputFiles[0].text },
  { type: 'CompiledWasm', path: 'tls.wasm', contents: readFileSync('tls-client/tls.wasm') } ],
  compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], cf: false, bindings: { KEY: secret, CERT: cert } });
 try {
  const good = await mf.dispatchFetch('https://test.example/'); assert.equal(good.status, 200, JSON.stringify({response:await good.clone().text(),dials:dials.length,securePeers,relayReceived,requests:plaintext.length}));
  assert.deepEqual(await good.json(), { status: 200, body: '{"challenge":"synthetic"}' });
  assert.equal(dials[0].host, address); assert.equal(dials[0].port, 443);
  assert.match(plaintext[0], /Host: localhost/); assert.match(plaintext[0], /v1,private-signature/);
  const prior = plaintext.length;
  assert.equal((await mf.dispatchFetch('https://test.example/?host=wrong.example')).status, 502);
  assert.equal(plaintext.length, prior, 'Hostname failure must send no application data');
  const dialCount = dials.length;
  assert.equal((await mf.dispatchFetch('https://test.example/?private')).status, 502);
  assert.equal(dials.length, dialCount, 'A rebinding/private answer on a new request must prevent every connection');
  for (const next of ['large', 'body-stall', 'terminal', 'redirect']) {
   mode = next; const started = performance.now();
   const response = await mf.dispatchFetch('https://test.example/?status'); assert.equal(response.status, 200);
   assert.deepEqual(await response.json(), { status: next === 'terminal' ? 410 : next === 'redirect' ? 302 : 200, body: '' });
   assert.ok(performance.now() - started < 1000);
  }
  mode = 'stall'; assert.equal((await mf.dispatchFetch('https://test.example/?abort')).status, 502);
  mode = 'echo';
  const headers = await auth(), url = `ws://127.0.0.1:${relayPort}/tunnel`;
  const ws = new WebSocket(url, { headers });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('error', () => {}); ws.terminate();
  assert.equal(await rejected(url, headers), 403, 'Same authenticated nonce may not reopen a connection');
  const oversized = new WebSocket(url, { headers: await auth() }); oversized.on('error', () => {});
  await new Promise<void>(resolve => oversized.once('open', resolve));
  const closed = new Promise<void>(resolve => oversized.once('close', resolve));
  oversized.send(Buffer.alloc(TUNNEL_BYTES + 1)); await closed;
 } finally {
  await mf.dispose();
 }
});
