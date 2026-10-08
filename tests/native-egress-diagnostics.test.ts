import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeEgressDiagnostics, nativeEgressDiagnosticResponse } from '../lib/calendar/native-egress-diagnostics.ts';

test('native egress probes are fixed empty HEAD requests, discard contents and never attest rebinding', async () => {
 const destinations: string[] = []; let cancellations = 0;
 const result = await nativeEgressDiagnostics(AbortSignal.timeout(1000), async (input, init) => {
  const url = String(input); destinations.push(url);
  assert.equal(init?.method, 'HEAD'); assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit');
  assert.equal(init.headers, undefined); assert.equal(init.body, undefined);
  if (url.includes('sslip.io')) throw new Error('Destination address is disallowed: sensitive runtime details');
  if (url.includes('10.255.')) throw new Error('Connection refused: sensitive runtime details');
  return new Response(new ReadableStream({ cancel() { cancellations++; } }), { status: url.includes('redirect-to') ? 302 : 200 });
 });
 assert.equal(destinations.length, 10); assert.equal(cancellations, 8);
 assert.equal(result.observations.find(x => x.name === 'dns_loopback')?.outcome, 'policy_rejection');
 assert.equal(result.observations.find(x => x.name === 'private_v4')?.outcome, 'network_failure');
 assert.equal(result.observations.find(x => x.name === 'redirect_to_loopback')?.status, 302);
 assert.equal(result.dnsRebindingTested, false); assert.equal(result.callbackContractVerified, false);
 assert.equal(result.responseContents, 'discarded'); assert.ok(!JSON.stringify(result).includes('sensitive'));
});

test('native egress diagnostics require authenticated same-origin empty POST before egress', async () => {
 let calls = 0;
 const fetcher: typeof fetch = async () => { calls++; return new Response(); };
 const origin = 'https://example.chatgpt.site', url = origin + '/api/diagnostics/native-egress';
 const headers = { 'oai-authenticated-user-id': 'synthetic', origin };
 for (const [request, status, siteOrigin] of [
  [new Request(url, { method: 'POST' }), 401, origin],
  [new Request(url, { headers }), 400, origin],
  [new Request(url + '?url=http://127.0.0.1', { method: 'POST', headers }), 400, origin],
  [new Request(url, { method: 'POST', headers: { ...headers, origin: 'https://untrusted.example' } }), 403, origin],
  [new Request(url, { method: 'POST', headers }), 403, undefined],
  [new Request(url, { method: 'POST', headers, body: '{}' }), 400, origin],
 ] as const) assert.equal((await nativeEgressDiagnosticResponse(request, siteOrigin, fetcher)).status, status);
 assert.equal(calls, 0);
 const response = await nativeEgressDiagnosticResponse(new Request(url, { method: 'POST', headers }), origin, fetcher);
 assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(calls, 10);
 // Fetch implementations may represent Content-Length: 0 with a body stream.
 const emptyStream = new Request(url, { method: 'POST', headers, body: '' });
 assert.notEqual(emptyStream.body, null);
 assert.equal((await nativeEgressDiagnosticResponse(emptyStream, origin, fetcher)).status, 200);
 assert.equal(calls, 20);
});

test('an aborted native egress diagnostic sends no requests and records no policy success', async () => {
 const controller = new AbortController(); controller.abort(); let calls = 0;
 const result = await nativeEgressDiagnostics(controller.signal, async () => { calls++; return new Response(); });
 assert.equal(calls, 0);
 assert.ok(result.observations.every(x => x.outcome === 'timeout'));
 assert.equal(result.callbackContractVerified, false);
});
