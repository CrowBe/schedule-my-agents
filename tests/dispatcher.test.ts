import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createHmac } from 'node:crypto';
import { seal } from '../lib/calendar/crypto.ts';
import { CALLBACK_PATH, LATE_WINDOW, mac, signedHeaders, verified, type AlarmJob } from '../shared/alarm.ts';

async function dispatcherBundle() {
  return (await build({ entryPoints: ['dispatcher/src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers', 'cloudflare:sockets'] })).outputFiles[0].text;
}
async function waitFor(check: () => Promise<boolean>, timeout = 12_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.fail('Durable alarm did not complete within the test deadline.');
}

test('timer socket diagnostic authenticates fixed empty requests before any DNS or socket work', async () => {
 const registration = btoa('r'.repeat(32)); let dns = 0;
 const mf = new Miniflare({ modules: true, script: await dispatcherBundle(), compatibilityDate: '2026-05-15', cf: false,
  durableObjects: { ALARMS: { className: 'Alarm', useSQLite: true } },
  bindings: { REGISTRATION_KEY: registration },
  outboundService: async request => {
   assert.equal(new URL(request.url).hostname, 'cloudflare-dns.com'); dns++;
   return Response.json({ Status: 0, Answer: [] });
  },
 });
 const path = '/diagnostics/callback-socket', url = 'https://alarm.example' + path;
 try {
  assert.equal((await mf.dispatchFetch(url, { method: 'POST' })).status, 401);
  assert.equal((await mf.dispatchFetch(url + '?host=private', { method: 'POST' })).status, 400);
  assert.equal((await mf.dispatchFetch(url)).status, 400);
  assert.equal((await mf.dispatchFetch(url, { method: 'POST', body: '{}', headers: await signedHeaders(registration, path, '{}') })).status, 400);
  assert.equal(dns, 0);
  const response = await mf.dispatchFetch(url, { method: 'POST', headers: await signedHeaders(registration, path, '') });
  assert.equal(response.status, 200); assert.equal(dns, 4);
  const result = await response.json() as { applicationBytesSent: number; callbackContractVerified: boolean; observations: { outcome: string }[] };
  assert.equal(result.applicationBytesSent, 0); assert.equal(result.callbackContractVerified, false);
  assert.ok(result.observations.every(x => x.outcome === 'resolution_or_address_policy_failure'));
 } finally { await mf.dispose(); }
});

test('real SQLite Durable Object alarm survives runtime restart; failed/redirect callback retries and registration is idempotent', async () => {
  const script = await dispatcherBundle(); const persist = mkdtempSync(join(tmpdir(), 'opaque-alarm-'));
  const registration = btoa('r'.repeat(32)), callback = btoa('c'.repeat(32));
  let attempts = 0; let acknowledged = false;
  const create = () => new Miniflare({ modules: true, script, compatibilityDate: '2026-05-15', cf: false,
    durableObjects: { ALARMS: { className: 'Alarm', useSQLite: true } }, durableObjectsPersist: persist,
    bindings: { REGISTRATION_KEY: registration, CALLBACK_KEY: callback, CALLBACK_URL: 'https://site.example' + CALLBACK_PATH },
    outboundService: async (request) => {
      const body = await request.text(); assert.ok(await verified(new Request(request.url, { headers: Object.fromEntries(request.headers) }), body, callback, Date.now()));
      attempts++;
      if (attempts === 1) return new Response(null, { status: 302, headers: { location: 'https://untrusted.example' } });
      acknowledged = true; return new Response(null, { status: 204 });
    },
  });
  let mf = create();
  try {
    const dueAt = Date.now() + 2000;
    const job: AlarmJob = { id: await mac(registration, 'job'), envelope: await seal('no-identities', btoa('e'.repeat(32)), 'test'), dueAt, expiresAt: dueAt + LATE_WINDOW };
    const body = JSON.stringify(job);
    assert.equal((await mf.dispatchFetch('https://alarm.example/alarms', { method: 'POST', body })).status, 401);
    const register = async () => mf.dispatchFetch('https://alarm.example/alarms', { method: 'POST', body, headers: await signedHeaders(registration, '/alarms', body) });
    for (const r of await Promise.all([register(), register()])) assert.equal(r.status, 200);
    await mf.dispose(); mf = create(); // alarm and encrypted envelope are recovered from persisted SQLite
    await waitFor(async () => acknowledged);
    assert.equal(attempts, 2);
    assert.equal((await register()).status, 200);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(attempts, 2, 'registration retry must not restart an acknowledged alarm');
  } finally { await mf.dispose(); rmSync(persist, { recursive: true, force: true }); }
});

test('Workers E2E: Google sync → encrypted registration → actual alarm → signed Site callback → live Google lookup → D1 signed delivery and retry across runtime restart', async () => {
  const dispatcher = await dispatcherBundle();
  const site = (await build({ stdin: { contents: `import { CalendarService } from './lib/calendar/service.ts'; export default { fetch(r,e) { return new CalendarService(e,{callbackTransport:{post:(url,body,headers,signal)=>fetch(url,{method:'POST',body,headers,signal,redirect:'manual'})}}).handle(r); } };`, resolveDir: process.cwd(), sourcefile: 'alarm-site.ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' })).outputFiles[0].text;
  const registration = btoa('r'.repeat(32)), callback = btoa('c'.repeat(32)), encryption = btoa('e'.repeat(32));
  const dueAt = Date.now() + 3000;
  const event = { id: 'private-event', summary: 'Only the Site sees this', start: { dateTime: new Date(dueAt).toISOString() } };
  let lookup = 0; let registrationCount = 0; const delivered: {body:string; id:string; timestamp:string}[] = [];
  const webhookSecret = 'whsec_' + btoa('s'.repeat(32));
  const outboundService = async (request: Request) => {
    const url = new URL(request.url);
    if (url.origin === 'https://receiver.example') {
      const body = await request.text(), id = request.headers.get('webhook-id')!, timestamp = request.headers.get('webhook-timestamp')!;
      const expected = 'v1,' + createHmac('sha256', Buffer.from(webhookSecret.slice(6),'base64')).update(`${id}.${timestamp}.${body}`).digest('base64');
      assert.equal(request.headers.get('webhook-signature'),expected);
      const parsed = JSON.parse(body);
      if (parsed.type === 'verification') return Response.json({challenge:parsed.challenge});
      assert.equal(parsed.eventId,id); assert.equal(parsed.data.eventId,'private-event');
      delivered.push({body,id,timestamp});
      return new Response(null,{status:delivered.length===1?503:204});
    }
    if (url.origin === 'https://alarm.example') {
      const body = await request.text(); assert.ok(!body.includes('private-event')); assert.ok(!body.includes('private-owner'));
      registrationCount++;
      return (await mf.getWorker('dispatcher')).fetch(url.href, { method: 'POST', body, headers: Object.fromEntries(request.headers) });
    }
    if (url.origin === 'https://site.example') return mf.dispatchFetch(url.href, { method: 'POST', body: await request.text(), headers: Object.fromEntries(request.headers) });
    if (url.origin === 'https://oauth2.googleapis.com') return Response.json({ access_token: 'access' });
    assert.equal(url.origin, 'https://www.googleapis.com');
    if (url.pathname.endsWith('/private-event')) { lookup++; return Response.json(event); }
    if (url.pathname.endsWith('/events')) return Response.json({ items: [event] });
    throw new Error('Unexpected outbound request.');
  };
  const persist = mkdtempSync(join(tmpdir(), 'signed-delivery-'));
  const create = () => new Miniflare({ cf: false, d1Persist: join(persist,'d1'), durableObjectsPersist: join(persist,'alarms'), workers: [
    { name: 'site', modules: true, script: site, compatibilityDate: '2026-05-15', d1Databases: { DB: 'site-alarm-test' },
      bindings: { MCP_EVENTS_READY:'true', GOOGLE_WEBHOOK_VERIFIED:'true', SITE_ORIGIN: 'https://site.example', DISPATCHER_ORIGIN: 'https://alarm.example', ALARM_REGISTRATION_KEY: registration, ALARM_CALLBACK_KEY: callback, ALARM_ENCRYPTION_KEY: encryption,
        TOKEN_ENCRYPTION_KEY: encryption, GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret' }, outboundService },
    { name: 'dispatcher', modules: true, script: dispatcher, compatibilityDate: '2026-05-15', durableObjects: { ALARMS: { className: 'Alarm', useSQLite: true } },
      bindings: { REGISTRATION_KEY: registration, CALLBACK_KEY: callback, CALLBACK_URL: 'https://site.example' + CALLBACK_PATH }, outboundService },
  ] });
  let mf = create();
  try {
    const db = await mf.getD1Database('DB', 'site');
    for (const file of readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort()) {
      for (const sql of readFileSync(`drizzle/${file}`, 'utf8').split('--> statement-breakpoint').filter(s => s.trim())) await db.prepare(sql).run();
    }
    const owner = 'private-owner';
    await db.prepare('INSERT INTO connections VALUES (?, ?, ?)').bind(owner, await seal('refresh', encryption, owner), Date.now()).run();
    await db.prepare('INSERT INTO calendars VALUES (?, ?, ?, 1, ?)').bind(owner, 'cal', 'Personal', 'grant').run();
    await db.prepare("INSERT INTO watches (id, owner, calendar_id, generation, token_hash, resource_id, expiration, status) VALUES ('watch', ?, 'cal', 'grant', 'hash', 'resource', ?, 'active')").bind(owner, Date.now() + 3600_000).run();
    for(const [principal, count] of [[owner,1],['other',0]] as const) {
      const catalog = await mf.dispatchFetch('https://site.example/mcp',{method:'POST',headers:{'oai-authenticated-user-id':principal},body:JSON.stringify({id:2,method:'events/list'})});
      assert.equal(((await catalog.json()) as {result:{events:unknown[]}}).result.events.length,count);
    }
    const status = await (await mf.dispatchFetch('https://site.example/api/status',{headers:{'oai-authenticated-user-id':owner}})).json() as {eventStartReady:boolean};assert.equal(status.eventStartReady,true);
    const subscribe = await mf.dispatchFetch('https://site.example/mcp', {method:'POST',headers:{'oai-authenticated-user-id':owner,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'events/subscribe',params:{name:'calendar.event.starting',arguments:{calendarId:'cal'},delivery:{mode:'webhook',url:'https://receiver.example/callback',secret:webhookSecret}}})});
    const subscribed = await subscribe.json() as {result?:{id:string};error?:unknown}; assert.ok(subscribed.result,JSON.stringify(subscribed));
    const resync = await mf.dispatchFetch('https://site.example/api/calendars/resync', { method: 'POST', headers: { origin: 'https://site.example', 'oai-authenticated-user-id': owner }, body: JSON.stringify({ calendarId: 'cal' }) });
    assert.equal(resync.status, 200, await resync.text()); assert.equal(registrationCount, 1);
    // The pending snapshot is not the scheduler's source of truth.
    await db.prepare('DELETE FROM events').run();
    await waitFor(async () => Boolean(await db.prepare('SELECT id FROM occurrence_outbox').first()));
    await waitFor(async()=>Boolean(await db.prepare("SELECT subscription_id FROM deliveries WHERE attempts = 1 AND status = 'pending' AND lease_until = 0").first()));
    await new Promise(resolve=>setTimeout(resolve,100));
    await mf.dispose(); mf = create();
    const recovered = await mf.getD1Database('DB','site');
    await waitFor(async()=>Boolean(await recovered.prepare("SELECT subscription_id FROM deliveries WHERE status = 'accepted'").first()));
    assert.equal(delivered.length,2);assert.equal(delivered[0].body,delivered[1].body);assert.equal(delivered[0].id,delivered[1].id);assert.notEqual(delivered[0].timestamp,delivered[1].timestamp);
    assert.ok(lookup >= 2);
    const row = await recovered.prepare('SELECT * FROM occurrence_outbox').first<{due_at: number; created_at: number; payload: string}>();
    assert.equal(row!.due_at, dueAt); assert.ok(row!.created_at >= dueAt); assert.ok(row!.created_at - dueAt < 60_000);
    assert.equal(JSON.parse(row!.payload).title, event.summary);
  } finally { await mf.dispose(); rmSync(persist,{recursive:true,force:true}); }
});
