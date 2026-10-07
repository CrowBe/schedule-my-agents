import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeVerificationProbe } from '../lib/calendar/callback-probe.ts';

test('native diagnostic never activates a subscription even with a valid challenge echo', async () => {
 const original = globalThis.fetch; let callbackPosts = 0;
 globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === 'cloudflare-dns.com') return Response.json({ Status: 0, Answer: url.searchParams.get('type') === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [] });
  callbackPosts++; assert.equal(init?.redirect, 'manual');
  return Response.json({ challenge: 'synthetic' });
 };
 try {
  await assert.rejects(nativeVerificationProbe.post('https://receiver.example/hook', JSON.stringify({ type: 'verification', challenge: 'synthetic' }), {}, AbortSignal.timeout(1000)), /cannot activate/);
  assert.equal(callbackPosts, 1);
 } finally { globalThis.fetch = original; }
});

test('native diagnostic cannot send calendar event payloads', async () => {
 const original = globalThis.fetch; let calls = 0;
 globalThis.fetch = async () => { calls++; throw new Error('Unexpected network request'); };
 try {
  await assert.rejects(nativeVerificationProbe.post('https://receiver.example/hook', JSON.stringify({ eventId: 'evt_test', data: { title: 'Private' } }), {}, AbortSignal.timeout(1000)), /rejected input/);
  assert.equal(calls, 0);
 } finally { globalThis.fetch = original; }
});
