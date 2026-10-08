import test from 'node:test';
import assert from 'node:assert/strict';
import { timerSocketDiagnostics } from '../lib/calendar/timer-socket-diagnostics.ts';
import { verified } from '../shared/alarm.ts';

test('Site timer probe sends only existing registration authentication and an empty fixed request', async context => {
 const secret = btoa('r'.repeat(32)); let calls = 0;
 context.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  calls++; assert.equal(String(input), 'https://alarm.example/diagnostics/callback-socket');
  assert.equal(init?.method, 'POST'); assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit');
  assert.equal(init.body, undefined);
  const request = new Request(input, init);
  assert.ok(await verified(request, '', secret, Date.now()));
  assert.deepEqual([...request.headers.keys()].sort(), ['content-type', 'x-alarm-signature', 'x-alarm-time']);
  return Response.json({ observations: [], applicationBytesSent: 0, callbackContractVerified: false });
 });
 assert.equal((await timerSocketDiagnostics({ DISPATCHER_ORIGIN: 'https://alarm.example', ALARM_REGISTRATION_KEY: secret }, AbortSignal.timeout(1000))).callbackContractVerified, false);
 assert.equal(calls, 1);
 for (const origin of ['http://alarm.example', 'https://alarm.example/path', 'https://user:password@alarm.example', 'https://alarm.example?url=private'])
  await assert.rejects(timerSocketDiagnostics({ DISPATCHER_ORIGIN: origin, ALARM_REGISTRATION_KEY: secret }, AbortSignal.timeout(1000)));
 assert.equal(calls, 1);
});
