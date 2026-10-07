import test from 'node:test';
import assert from 'node:assert/strict';
import { openCallbackSocket } from '../lib/calendar/callback-socket.ts';

test('callback connection uses another validated public address when the first is unavailable', async () => {
  const attempted: string[] = [], closed: string[] = [];
  const socket = await openCallbackSocket(['8.8.8.8','2606:4700:4700::1111'], AbortSignal.timeout(1000), address => {
    attempted.push(address);
    return { address, opened: address === '8.8.8.8' ? Promise.reject(new Error('connection refused')) : Promise.resolve(), closed: Promise.resolve(), async close() { closed.push(address); } };
  });
  assert.equal(socket.address,'2606:4700:4700::1111');
  assert.deepEqual(attempted,['8.8.8.8','2606:4700:4700::1111']);
  assert.deepEqual(closed,['8.8.8.8']);
});

test('all DNS answers are validated first, each candidate is tried once, and disallowed errors stay redacted', async () => {
  let calls=0;
  const connect = () => { calls++; return { opened:Promise.reject(new Error('proxy request failed, cannot connect to the specified address (private-token)')),closed:Promise.resolve(),async close(){} }; };
  await assert.rejects(openCallbackSocket(['8.8.8.8','10.0.0.1'],AbortSignal.timeout(1000),connect),/unsafe_destination/);
  assert.equal(calls,0);
  const logs:unknown[][]=[], original=console.info; console.info=(...args:unknown[])=>{logs.push(args);};
  try {
    await assert.rejects(openCallbackSocket(['8.8.8.8','8.8.8.8','2606:4700:4700::1111'],AbortSignal.timeout(1000),connect),/proxy request failed/);
    assert.equal(calls,2);
    assert.deepEqual(logs,[['calendar_callback_socket',{attempt:1,family:'ipv4',category:'destination_disallowed'}],['calendar_callback_socket',{attempt:2,family:'ipv6',category:'destination_disallowed'}]]);
    assert.ok(!JSON.stringify(logs).includes('private-token'));
  } finally { console.info=original; }
});

test('abort closes a pending socket and prevents attempts at further addresses', async () => {
  const controller=new AbortController(); let calls=0, closed=0;
  const pending=openCallbackSocket(['8.8.8.8','1.1.1.1'],controller.signal,()=>{
    calls++; return {opened:new Promise<void>(()=>{}),closed:Promise.resolve(),async close(){closed++;}};
  });
  controller.abort(new DOMException('cancelled','AbortError'));
  await assert.rejects(pending,error=>error instanceof Error&&error.name==='AbortError');
  assert.equal(calls,1); assert.equal(closed,1);
});
