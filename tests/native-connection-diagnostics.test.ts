import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyHead, fixtureAddresses, nativeConnectionDiagnostics, nativeRebindingDiagnostics } from '../lib/calendar/native-connection-diagnostics.ts';
import { authenticatedDiagnosticResponse } from '../lib/calendar/native-egress-diagnostics.ts';

const publicIp = '34.193.104.167';

test('connection probes discard contents and distinguish Host routing from selected-address proof', async () => {
 const calls: { url: string; host?: string }[] = [], handshakes: string[][] = []; let cancelled = 0;
 const result = await nativeConnectionDiagnostics(AbortSignal.timeout(1000), {
  resolve: async () => [publicIp],
  fetcher: async (input, init) => {
   const url = String(input), host = new Headers(init?.headers).get('host') ?? undefined;
   assert.equal(init?.method, 'HEAD'); assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit');
   assert.equal(init.body, undefined); assert.deepEqual([...new Headers(init.headers).keys()], host ? ['host'] : []);
   assert.ok(!host || ['httpbin.org', 'example.com'].includes(host)); calls.push({ url, host });
   // A proxy that routes on Host could return this even for a loopback IP URL.
   return host ? new Response(null, { status: 204 }) : new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 403 });
  },
  tlsProbe: async (name, host, address, servername) => {
   handshakes.push([name, host, address, servername]); return { name, outcome: 'synthetic_handshake', elapsedMs: 0 };
  },
 });
 assert.equal(calls.length, 27); assert.equal(cancelled, 23);
 assert.deepEqual(handshakes.map(x => x.slice(1)), [
  ['httpbin.org', publicIp, 'httpbin.org'], ['httpbin.org', publicIp, 'example.com'],
  ['connectors.api.openai.com', publicIp, 'connectors.api.openai.com'],
 ]);
 assert.equal(result.literalHostRoutingFalsified, true);
 assert.equal(result.applicationBytesSentByTlsProbes, 0);
 assert.equal(result.actualConnectedAddressObserved, false); assert.equal(result.callbackContractVerified, false);
});

test('unsafe DNS answers prevent every literal-address and TLS candidate probe', async () => {
 let tlsCalls = 0; const urls: string[] = [];
 const result = await nativeConnectionDiagnostics(AbortSignal.timeout(1000), {
  resolve: async () => [publicIp, '127.0.0.1'],
  fetcher: async input => { urls.push(String(input)); return new Response(null, { status: 403 }); },
  tlsProbe: async name => { tlsCalls++; return { name, outcome: 'unexpected', elapsedMs: 0 }; },
 });
 assert.equal(tlsCalls, 0); assert.equal(urls.length, 22);
 assert.equal(result.observations.filter(x => x.outcome === 'resolution_or_address_policy_failure').length, 2);
 assert.equal(result.literalHostRoutingFalsified, false);
});

test('DNS-change experiment observes both answers without claiming the runtime peer', async () => {
 const counts = new Map<string, number>(), headHosts: string[] = [];
 const result = await nativeRebindingDiagnostics(AbortSignal.timeout(1000), {
  resolve: async () => [publicIp],
  fetcher: async (input, init) => {
   const url = new URL(String(input)); assert.equal(init?.body, undefined);
   assert.equal(init?.redirect, 'manual'); assert.equal(init?.credentials, 'omit');
   if (url.hostname === 'cloudflare-dns.com') {
    assert.deepEqual([...new Headers(init?.headers)], [['accept', 'application/dns-json']]);
    const host = url.searchParams.get('name')!;
    assert.ok(host.endsWith('.1u.ms') || host.endsWith('.rebind.network'));
    assert.ok(host.split('.').every(label => label.length <= 63));
    const count = counts.get(host) ?? 0; counts.set(host, count + 1);
    return Response.json({ Status: 0, Answer: [{ type: 1, data: count ? '127.0.0.1' : publicIp }] });
   }
   assert.equal(init?.method, 'HEAD'); assert.equal(init.headers, undefined); headHosts.push(url.hostname);
   return new Response(null, { status: headHosts.length === 1 ? 204 : 403 });
  },
 });
 assert.equal(counts.size, 2); assert.equal(headHosts.length, 3);
 assert.ok(result.trials.every(x => x.publicThenLoopbackObserved));
 assert.equal(result.dnsAnswerChangeObserved, true);
 assert.equal(result.actualConnectedAddressObserved, false); assert.equal(result.callbackContractVerified, false);
});

test('unavailable or contaminated fixtures cannot count as a DNS-change result', async () => {
 let heads = 0;
 const result = await nativeRebindingDiagnostics(AbortSignal.timeout(1000), {
  resolve: async () => [publicIp],
  fetcher: async (input, init) => {
   if (init?.method === 'HEAD') { heads++; return new Response(null, { status: 204 }); }
   const host = new URL(String(input)).searchParams.get('name')!;
   return host.endsWith('.1u.ms') ? Response.json({ Status: 3 }) :
    Response.json({ Status: 0, Answer: [{ type: 1, data: publicIp }, { type: 1, data: '127.0.0.1' }] });
  },
 });
 assert.equal(heads, 1); assert.equal(result.dnsAnswerChangeObserved, false);
 assert.ok(result.trials.every(x => !x.publicThenLoopbackObserved));
});

test('probe deadlines return despite stalled adapters and discard late contents', async () => {
 const controller = new AbortController(); let complete!: (response: Response) => void, cancelled = 0;
 const work = emptyHead('fixed', 'https://httpbin.org/status/204', controller.signal,
  () => new Promise(resolve => { complete = resolve; }));
 controller.abort(); assert.equal((await work).outcome, 'timeout');
 complete(new Response(new ReadableStream({ cancel() { cancelled++; } })));
 await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, 1);
 const dnsAbort = new AbortController(); let dnsComplete!: (response: Response) => void;
 const dns = fixtureAddresses('fixed.1u.ms', dnsAbort.signal, () => new Promise(resolve => { dnsComplete = resolve; }));
 dnsAbort.abort(); await assert.rejects(dns);
 dnsComplete(new Response(new ReadableStream({ cancel() { cancelled++; } })));
 await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, 2);
 await assert.rejects(fixtureAddresses('fixed.1u.ms', AbortSignal.timeout(1000), async () => new Response('x'.repeat(4097))));
});

test('shared diagnostic guard denies unauthenticated and caller-controlled requests before work', async () => {
 let calls = 0; const run = async () => { calls++; return { synthetic: true }; };
 const origin = 'https://example.chatgpt.site', url = origin + '/api/diagnostics/native-connection';
 const headers = { 'oai-authenticated-user-id': 'synthetic', origin };
 for (const request of [new Request(url, { method: 'POST' }),
  new Request(url + '?host=private', { method: 'POST', headers }),
  new Request(url, { method: 'POST', headers, body: 'private' }),
  new Request(url, { method: 'POST', headers: { ...headers, origin: 'https://untrusted.example' } }),
 ]) assert.notEqual((await authenticatedDiagnosticResponse(request, origin, run, 'synthetic_audit')).status, 200);
 assert.equal(calls, 0);
 assert.equal((await authenticatedDiagnosticResponse(new Request(url, { method: 'POST', headers }), origin, run, 'synthetic_audit')).status, 200);
 assert.equal(calls, 1);
});
