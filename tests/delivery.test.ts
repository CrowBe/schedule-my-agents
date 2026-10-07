import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { serializeOccurrence, deliveryHeaders, deliveryOutcome, MAX_EVENT_BYTES } from '../lib/calendar/delivery.ts';
import type { CalendarEvent } from '../lib/calendar/types.ts';
const occurrence: CalendarEvent = { id: 'internal', calendarId: 'personal', providerEventId: 'google-id', provider: 'google', start: '2026-10-06T20:00:00+11:00', status: 'confirmed', title: 'Review', description: 'Untrusted calendar text', recurringEventId: 'series' };
test('minimal envelope separates logical and provider identity and preserves occurrence time', () => {
  const event = JSON.parse(serializeOccurrence('evt_logical', occurrence));
  assert.deepEqual(event, { eventId: 'evt_logical', name: 'calendar.event.starting', timestamp: '2026-10-06T09:00:00.000Z', data: { calendarId: 'personal', eventId: 'google-id', start: occurrence.start, title: 'Review', description: occurrence.description }, cursor: null });
  for (const value of [{...occurrence,status:'cancelled'},{...occurrence,start:'invalid'}]) assert.throws(()=>serializeOccurrence('evt_logical',value));
  assert.throws(()=>serializeOccurrence('google-id',occurrence));
});
test('payload bound counts UTF-8 bytes and never truncates content', () => {
  const base = serializeOccurrence('evt_logical', {...occurrence,description:''});
  const available = MAX_EVENT_BYTES - new TextEncoder().encode(base).byteLength;
  assert.equal(new TextEncoder().encode(serializeOccurrence('evt_logical',{...occurrence,description:'a'.repeat(available)})).byteLength, MAX_EVENT_BYTES);
  assert.throws(()=>serializeOccurrence('evt_logical',{...occurrence,description:'a'.repeat(available+1)}));
  assert.throws(()=>serializeOccurrence('evt_logical',{...occurrence,description:'界'.repeat(Math.ceil(available/3))}));
});
test('independent receiver verifies exact body, both rotation keys and fresh retry signatures', async () => {
  const body = serializeOccurrence('evt_logical',occurrence), now = 1791277200000;
  const secret = 'whsec_'+Buffer.alloc(32,1).toString('base64'), previous = 'whsec_'+Buffer.alloc(32,2).toString('base64');
  const headers = await deliveryHeaders(secret,previous,now+1000,'evt_logical','sub_owner',body,now);
  assert.equal(headers['webhook-id'],'evt_logical'); assert.equal(headers['X-MCP-Subscription-Id'],'sub_owner');
  const signatures = headers['webhook-signature'].split(' ');
  for(const [i,key] of [secret,previous].entries()) {
    const expected = 'v1,'+createHmac('sha256',Buffer.from(key.slice(6),'base64')).update(`evt_logical.${Math.floor(now/1000)}.${body}`).digest('base64');
    assert.equal(signatures[i],expected);
  }
  const retry = await deliveryHeaders(secret,previous,now+1000,'evt_logical','sub_owner',body,now+1000);
  assert.equal(retry['webhook-id'],headers['webhook-id']); assert.notEqual(retry['webhook-signature'],headers['webhook-signature']);
  assert.equal(retry['webhook-signature'].split(' ').length,1);
});
test('receipt, terminal responses and transient failures have separate outcomes', () => {
  for(const status of [200,202,204]) assert.equal(deliveryOutcome(status),'accepted');
  for(const status of [301,302,307,410,413]) assert.equal(deliveryOutcome(status),'terminal');
  for(const status of [408,429,500,503]) assert.equal(deliveryOutcome(status),'retry');
});

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { Subscriptions, signedHeaders, type CallbackTransport } from '../lib/calendar/subscriptions.ts';
import { Store } from '../lib/calendar/store.ts';
import { Deliveries } from '../lib/calendar/delivery.ts';
import { createNativeOpenAICallbackTransport } from '../lib/calendar/native-callback-transport.ts';
import type { Environment, Statement } from '../lib/calendar/types.ts';
function fixture() {
  const sql = new DatabaseSync(':memory:');
  for (const f of readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort()) sql.exec(readFileSync('drizzle/'+f,'utf8'));
  class Prepared implements Statement {
    values: SQLInputValue[] = []; constructor(private query: string) {}
    bind(...v: unknown[]) { this.values=v as SQLInputValue[]; return this; }
    async first<T>() { return (sql.prepare(this.query).get(...this.values) ?? null) as T | null; }
    async all<T>() { return {results:sql.prepare(this.query).all(...this.values) as T[]}; }
    async run() { return sql.prepare(this.query).run(...this.values); }
  }
  const DB = {prepare:(q:string)=>new Prepared(q), async batch(statements:Statement[]) { sql.exec('BEGIN'); try { for(const s of statements) await s.run(); sql.exec('COMMIT'); } catch(e) { sql.exec('ROLLBACK'); throw e; } }};
  const env: Environment = {DB,TOKEN_ENCRYPTION_KEY:btoa('a'.repeat(32))};
  sql.exec("INSERT INTO connections VALUES ('alice','encrypted',0); INSERT INTO calendars VALUES ('alice','personal','Personal',1,'g1'); INSERT INTO calendars VALUES ('alice','disabled','Disabled',0,'g2')");
  let now=1791200000000, calls=0;
  let respond: CallbackTransport['post'] = async (_url,body,headers) => {
    calls++; const expected = await signedHeaders(params.delivery.secret, headers['webhook-id'],headers['X-MCP-Subscription-Id'],body,now);
    assert.deepEqual(headers,expected); assert.equal(JSON.parse(body).type,'verification');
    return Response.json({challenge:JSON.parse(body).challenge});
  };
  const transport:CallbackTransport = {post:(...args)=>respond(...args)};
  const store=new Store(DB);
  const service=()=>new Subscriptions(store,env,()=>now,transport);
  const params={name:'calendar.event.starting',arguments:{calendarId:'personal'},delivery:{mode:'webhook',url:'https://receiver.example.com:443/callback',secret:'whsec_'+btoa('s'.repeat(32))},ttlMs:600_000};
  return {sql,env,store,service,params, setNow:(v:number)=>now=v, now:()=>now,calls:()=>calls,setRespond:(r:CallbackTransport['post'])=>respond=r};
}
async function ready(callbackUrl?: string) {
  const f = fixture();
  if (callbackUrl) f.params.delivery.url = callbackUrl;
  const sub = await f.service().subscribe('alice', f.params);
  const event = {...occurrence, start:new Date(f.now()).toISOString()};
  await f.store.claimDue('logical','alice','personal','g1',event,f.now(),f.now(),f.now()+300_000);
  const dispatch = () => new Deliveries(f.store,f.env,f.now,{post:(...args)=>respond(...args)}).dispatch('logical',event);
  let respond: CallbackTransport['post'] = async()=>new Response(null,{status:204});
  return {...f, sub, event, dispatch, response:(r:CallbackTransport['post'])=>respond=r};
}
test('persisted delivery retries keep bytes and identity; accepted receipt survives restart and duplicate wake', async()=>{
  const f=await ready(); const bodies:string[]=[], ids:string[]=[], times:string[]=[];
  f.response(async(_url,body,headers)=>{bodies.push(body);ids.push(headers['webhook-id']);times.push(headers['webhook-timestamp']);return new Response(null,{status:bodies.length===1?503:204});});
  await assert.rejects(f.dispatch(), /pending durable retry/);
  await assert.rejects(f.dispatch(), /pending durable retry/); assert.equal(bodies.length,1);
  f.setNow(f.now()+2000); await f.dispatch(); await f.dispatch();
  assert.equal(bodies.length,2); assert.equal(bodies[0],bodies[1]); assert.equal(ids[0],ids[1]); assert.notEqual(times[0],times[1]);
  const row=f.sql.prepare('SELECT * FROM deliveries').get()!; assert.equal(row.status,'accepted'); assert.equal(row.attempts,2); assert.equal(row.body,'');
});
test('native delivery records a 2xx receipt without reading an oversized or stalled success body', async () => {
  for (const oversized of [false, true]) {
    const f = await ready('https://connectors.api.openai.com/mcp/events/test');
    let cancelled = false;
    const transport = createNativeOpenAICallbackTransport({ resolve: async () => ['104.18.10.1'], fetcher: async () =>
      new Response(new ReadableStream({ start(c) { if (oversized) c.enqueue(new Uint8Array(4097)); }, cancel() { cancelled = true; } }), { status: 200 }) });
    f.response(transport.post);
    await f.dispatch();
    const row = f.sql.prepare('SELECT status, attempts, last_status, body FROM deliveries').get()!;
    assert.deepEqual({ ...row }, { status: 'accepted', attempts: 1, last_status: 200, body: '' });
    assert.equal(cancelled, true);
    await f.dispatch();
    assert.equal(f.sql.prepare('SELECT attempts FROM deliveries').get()!.attempts, 1);
  }
});
test('concurrent dispatch has one lease; crash recovery retains logical identity and bounds attempts',async()=>{
  const f=await ready(); let calls=0, release!:()=>void;
  f.response(async()=>{calls++;await new Promise<void>(resolve=>release=resolve);return new Response(null,{status:204});});
  const first=f.dispatch();
  while(!calls) await new Promise(resolve=>setTimeout(resolve,1));
  await assert.rejects(f.dispatch(),/pending durable retry/); assert.equal(calls,1); release();await first;
  f.sql.exec("UPDATE deliveries SET status='pending', body='persisted', attempts=5, next_at=0, lease='crashed', lease_until=0");
  f.response(async()=>{calls++; throw new Error('lost acknowledgement');});
  await f.dispatch(); assert.equal(f.sql.prepare('SELECT status FROM deliveries').get()!.status,'exhausted');
  await f.dispatch();assert.equal(calls,2);
});
test('edit, expiry, disable, disconnect and unsubscribe prevent queued dispatch and clear content',async()=>{
  for(const action of ['edit','expiry','disable','disconnect','unsubscribe']) {
    const f=await ready(); let calls=0;f.response(async()=>{calls++;return new Response(null,{status:503});});
    await assert.rejects(f.dispatch()); assert.equal(calls,1);f.setNow(f.now()+2000);
    if(action==='edit') f.event.title='Changed';
    if(action==='expiry') f.setNow(f.now()+300_000);
    if(action==='disable') await f.store.revoke('alice','personal','g2');
    if(action==='disconnect') await f.store.disconnect('alice');
    if(action==='unsubscribe') await f.service().unsubscribe('alice',f.params);
    await f.dispatch();assert.equal(calls,1);
    assert.equal(f.sql.prepare("SELECT count(*) n FROM deliveries WHERE body != ''").get()!.n,0);
  }
});
test('terminal receiver responses stop retries; subscription refresh uses current rotation keys',async()=>{
  for(const status of [410,413,302]) {
    const f=await ready();let calls=0;f.response(async()=>{calls++;return new Response(null,{status});});
    await f.dispatch();await f.dispatch();assert.equal(calls,1);assert.equal(f.sql.prepare('SELECT status FROM deliveries').get()!.status,'terminal');
  }
  const f=await ready();f.response(async()=>new Response(null,{status:503}));await assert.rejects(f.dispatch());
  f.params.delivery.secret='whsec_'+btoa('n'.repeat(32));await f.service().subscribe('alice',f.params);
  f.setNow(f.now()+2000);f.response(async(_url,body,headers)=>{
    assert.equal(headers['webhook-signature'].split(' ').length,2);
    const expected=createHmac('sha256',Buffer.from(f.params.delivery.secret.slice(6),'base64')).update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`).digest('base64');
    assert.ok(headers['webhook-signature'].startsWith('v1,'+expected));return new Response(null,{status:204});
  });await f.dispatch();
});
test('lost receiver acknowledgement retries the same logical event; audience stays frozen',async()=>{
  const f=await ready();const receipts:string[]=[];
  f.response(async(_url,body)=>{receipts.push(JSON.parse(body).eventId);if(receipts.length===1)throw new Error('receiver accepted but response was lost');return new Response(null,{status:204});});
  await assert.rejects(f.dispatch());
  await f.service().subscribe('alice',{...f.params,delivery:{...f.params.delivery,url:'https://another.example/callback'}});
  f.setNow(f.now()+2000);await f.dispatch();assert.deepEqual(receipts,['evt_logical','evt_logical']);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM deliveries').get()!.n,1);
});

test('native terminal responses with oversized bodies persist a terminal delivery without retries', async () => {
  for (const status of [302, 410, 413]) {
    const f = await ready('https://connectors.api.openai.com/mcp/events/test');
    let calls = 0;
    const transport = createNativeOpenAICallbackTransport({ resolve: async () => ['104.18.10.1'], fetcher: async () => {
      calls++; return new Response('x'.repeat(4097), { status });
    } });
    f.response(transport.post);
    await f.dispatch(); await f.dispatch();
    assert.equal(calls, 1);
    const row = f.sql.prepare('SELECT status, last_status, body FROM deliveries').get()!;
    assert.equal(row.status, 'terminal'); assert.equal(row.last_status, status); assert.equal(row.body, '');
  }
});

test('slow authority checks bound the send to the remaining lease and recover on retry', async () => {
  const f = await ready(), claimedAt = f.now();
  const first = f.store.first.bind(f.store);
  let delayed = false, calls = 0, stopped = false;
  f.store.first = async <T>(query: string, ...values: unknown[]) => {
    const row = await first<T>(query, ...values);
    if (!delayed && query.startsWith('SELECT s.* FROM subscriptions')) {
      delayed = true; f.setNow(claimedAt + 13_800);
    }
    return row;
  };
  f.response(async (_url, _body, _headers, signal) => {
    calls++;
    signal.addEventListener('abort', () => { stopped = true; }, { once: true });
    await new Promise(resolve => setTimeout(resolve, 300));
    return new Response(null, { status: 204 });
  });
  await assert.rejects(f.dispatch(), /pending durable retry/);
  assert.equal(stopped, true);
  assert.equal(f.sql.prepare('SELECT status FROM deliveries').get()!.status, 'pending');
  f.setNow(claimedAt + 17_000);
  f.response(async () => { calls++; return new Response(null, { status: 204 }); });
  await f.dispatch();
  assert.equal(calls, 2);
  assert.equal(f.sql.prepare('SELECT status FROM deliveries').get()!.status, 'accepted');
});

test('authority checks consuming the lease defer dispatch without dropping the event', async () => {
  const f = await ready(), claimedAt = f.now();
  const first = f.store.first.bind(f.store);
  let delayed = false, calls = 0;
  f.store.first = async <T>(query: string, ...values: unknown[]) => {
    const row = await first<T>(query, ...values);
    if (!delayed && query.startsWith('SELECT s.* FROM subscriptions')) {
      delayed = true; f.setNow(claimedAt + 15_001);
    }
    return row;
  };
  f.response(async () => { calls++; return new Response(null, { status: 204 }); });
  await assert.rejects(f.dispatch(), /pending durable retry/);
  assert.equal(calls, 0);
  f.setNow(f.now() + 2000); await f.dispatch();
  assert.equal(calls, 1);
  assert.equal(f.sql.prepare('SELECT status FROM deliveries').get()!.status, 'accepted');
});
