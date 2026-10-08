import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeOpenAICallbackTransport } from '../lib/calendar/native-callback-transport.ts';

const destination = 'https://connectors.api.openai.com/mcp/events/test';
const signal = () => AbortSignal.timeout(1000);
test('native OpenAI transport accepts a signed challenge and preserves delivery bytes', async () => {
 const body = JSON.stringify({ type: 'verification', challenge: 'synthetic' });
 const headers = { 'webhook-signature': 'v1,synthetic', 'webhook-id': 'msg_test' };
 let dnsChecks = 0;
 const transport = createNativeOpenAICallbackTransport({ resolve: async host => {
  assert.equal(host, 'connectors.api.openai.com'); dnsChecks++; return ['104.18.10.1'];
 }, fetcher: async (url, init) => {
  assert.equal(url, destination); assert.equal(init!.method, 'POST'); assert.equal(init!.redirect, 'manual');
  assert.equal(init!.credentials, 'omit'); assert.equal(init!.body, body); assert.deepEqual(init!.headers, headers);
  return Response.json({ challenge: 'synthetic' });
 } });
 assert.deepEqual(await (await transport.post(destination, body, headers, signal())).json(), { challenge: 'synthetic' });
 await transport.post(destination, body, headers, signal()); assert.equal(dnsChecks, 2);
});

test('native transport rejects arbitrary hosts, URL tricks, private answers and oversized bodies before POST', async () => {
 let calls = 0;
 const transport = createNativeOpenAICallbackTransport({ resolve: async () => ['104.18.10.1', '127.0.0.1'],
  fetcher: async () => { calls++; return new Response(); } });
 for (const url of ['http://connectors.api.openai.com/c', 'https://connectors.api.openai.com.evil.example/c',
  'https://connectors.api.openai.com:8443/c', 'https://user@connectors.api.openai.com/c',
  'https://connectors.api.openai.com/c#fragment', 'https://127.0.0.1/c', 'https://receiver.example/c', destination]) {
  await assert.rejects(transport.post(url, '{}', {}, signal()));
 }
 await assert.rejects(transport.post(destination, 'é'.repeat(131073), {}, signal()));
 assert.equal(calls, 0);
});

test('native transport leaves redirects unaccepted, cancels oversized replies and propagates timeout', async () => {
 let cancelled = false;
 const make = (fetcher: typeof fetch) => createNativeOpenAICallbackTransport({ fetcher, resolve: async () => ['104.18.10.1'], timeoutMs: 20 });
 const redirect = await make(async () => new Response(null, { status: 302, headers: { Location: 'https://unexpected.example' } })).post(destination, '{}', {}, signal());
 assert.equal(redirect.status, 302); assert.equal(redirect.ok, false);
 await assert.rejects(make(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4097)); }, cancel() { cancelled = true; } }))).post(destination, '{}', {}, signal()), /response_too_large/);
 assert.equal(cancelled, true);
 await assert.rejects(make(async (_url, init) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }))).post(destination, '{}', {}, signal()), { name: 'TimeoutError' });
});

test('native transport preserves non-success status without consuming an oversized or stalled body', async () => {
 for (const status of [302, 410, 413, 503]) {
  let cancelled = false;
  const transport = createNativeOpenAICallbackTransport({ resolve: async () => ['104.18.10.1'], fetcher: async () =>
   new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4097)); }, cancel() { cancelled = true; } }), { status }) });
  const response = await transport.post(destination, '{}', {}, signal());
  assert.equal(response.status, status);
  assert.equal(response.body, null);
  assert.equal(cancelled, true);
 }
});

test('native transport rejects credential-bearing, injected and oversized headers before egress', async () => {
 let calls = 0;
 const transport = createNativeOpenAICallbackTransport({ resolve: async () => { calls++; return ['104.18.10.1']; }, fetcher: async () => { calls++; return new Response(); } });
 const headerCases: Record<string, string>[] = [{ Authorization: 'Bearer synthetic' }, { Cookie: 'synthetic=secret' }, { Host: '127.0.0.1' },
  { 'webhook-id': 'valid\r\nHost: internal' }, { 'webhook-signature': 'x'.repeat(8193) }];
 for (const headers of headerCases) {
  await assert.rejects(transport.post(destination, '{}', headers, signal()), /callback_header/);
 }
 assert.equal(calls, 0);
});

test('native transport bounds stalled DNS, fetch and successful challenge bodies', async () => {
 for (const stage of ['dns', 'fetch', 'body']) {
  let cancelled = false;
  const never = <T>() => new Promise<T>(() => {});
  const transport = createNativeOpenAICallbackTransport({ timeoutMs: 15,
   resolve: async () => stage === 'dns' ? never<string[]>() : ['104.18.10.1'],
   fetcher: async () => stage === 'fetch' ? never<Response>() : new Response(new ReadableStream({ cancel() { cancelled = true; } })),
  });
  const result = await Promise.race([
   transport.post(destination, '{}', {}, signal()).then(() => 'unexpected_response', error => error.name),
   new Promise<string>(resolve => setTimeout(() => resolve('unbounded'), 60)),
  ]);
  assert.equal(result, 'TimeoutError', stage);
  if (stage === 'body') assert.equal(cancelled, true);
 }
});
