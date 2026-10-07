import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFetchDiagnostics, nativeFetchDiagnosticResponse } from '../lib/calendar/native-fetch-diagnostics.ts';

test('fixed native-fetch diagnostics stop redirects, bound bodies and redact errors', async () => {
 const destinations: string[] = []; let cancelled = false;
 const result = await nativeFetchDiagnostics(AbortSignal.timeout(3000), async (input, init) => {
  const url = new URL(String(input)); destinations.push(url.href);
  assert.equal(init?.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit');
  assert.equal(init.headers, undefined); assert.equal(init.body, undefined);
  assert.equal(url.protocol, 'https:'); assert.ok(['httpbin.org', 'badssl.com', 'wrong.host.badssl.com', 'self-signed.badssl.com'].includes(url.hostname));
  if (url.hostname.startsWith('wrong.') || url.hostname.startsWith('self-signed.')) throw new Error('Sensitive runtime details must not appear');
  if (url.pathname === '/redirect-to') return new Response(null, { status: 302, headers: { Location: 'https://unexpected.example/' } });
  if (url.pathname.startsWith('/delay/')) return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
  if (url.pathname.startsWith('/bytes/')) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8192)); }, cancel() { cancelled = true; } }));
  return new Response('fixture');
 });
 assert.equal(destinations.length, 7); assert.equal(cancelled, true);
 assert.equal(result.observations.find(item => item.name === 'redirect_manual')?.status, 302);
 assert.equal(result.observations.find(item => item.name === 'response_limit')?.outcome, 'response_limit');
 assert.equal(result.observations.find(item => item.name === 'timeout')?.outcome, 'timeout');
 assert.equal(result.dnsRebindingTested, false); assert.equal(result.callbackContractVerified, false);
 assert.equal(result.subscriptionActivation, 'disabled');
 assert.ok(!JSON.stringify(result).includes('Sensitive'));
});

test('native-fetch diagnostic rejects unauthenticated, parameterized and POST requests before any egress', async () => {
 let calls = 0;
 const fetcher: typeof fetch = async () => { calls++; throw new Error('Unexpected egress'); };
 const url = 'https://example.chatgpt.site/api/diagnostics/native-fetch';
 assert.equal((await nativeFetchDiagnosticResponse(new Request(url), fetcher)).status, 401);
 const headers = { 'oai-authenticated-user-id': 'synthetic' };
 assert.equal((await nativeFetchDiagnosticResponse(new Request(url + '?destination=https://unexpected.example', { headers }), fetcher)).status, 400);
 assert.equal((await nativeFetchDiagnosticResponse(new Request(url, { method: 'POST', headers }), fetcher)).status, 400);
 assert.equal(calls, 0);
});
