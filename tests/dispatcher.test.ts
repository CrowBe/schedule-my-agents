import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { seal } from '../lib/calendar/crypto.ts';
import { CALLBACK_PATH, LATE_WINDOW, mac, signedHeaders, verified, type AlarmJob } from '../shared/alarm.ts';

async function dispatcherBundle() {
  return (await build({ entryPoints: ['dispatcher/src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'] })).outputFiles[0].text;
}
async function waitFor(check: () => Promise<boolean>, timeout = 12_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.fail('Durable alarm did not complete within the test deadline.');
}

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

test('Workers E2E: Google sync → encrypted registration → actual alarm → signed Site callback → live Google lookup → D1 due work', async () => {
  const dispatcher = await dispatcherBundle();
  const site = (await build({ stdin: { contents: `import { CalendarService } from './lib/calendar/service.ts'; export default { fetch(r,e) { return new CalendarService(e).handle(r); } };`, resolveDir: process.cwd(), sourcefile: 'alarm-site.ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' })).outputFiles[0].text;
  const registration = btoa('r'.repeat(32)), callback = btoa('c'.repeat(32)), encryption = btoa('e'.repeat(32));
  const dueAt = Date.now() + 3000;
  const event = { id: 'private-event', summary: 'Only the Site sees this', start: { dateTime: new Date(dueAt).toISOString() } };
  let lookup = 0; let registrationCount = 0;
  const outboundService = async (request: Request) => {
    const url = new URL(request.url);
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
  const mf = new Miniflare({ cf: false, workers: [
    { name: 'site', modules: true, script: site, compatibilityDate: '2026-05-15', d1Databases: { DB: 'site-alarm-test' },
      bindings: { SITE_ORIGIN: 'https://site.example', DISPATCHER_ORIGIN: 'https://alarm.example', ALARM_REGISTRATION_KEY: registration, ALARM_CALLBACK_KEY: callback, ALARM_ENCRYPTION_KEY: encryption,
        TOKEN_ENCRYPTION_KEY: encryption, GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret' }, outboundService },
    { name: 'dispatcher', modules: true, script: dispatcher, compatibilityDate: '2026-05-15', durableObjects: { ALARMS: { className: 'Alarm', useSQLite: true } },
      bindings: { REGISTRATION_KEY: registration, CALLBACK_KEY: callback, CALLBACK_URL: 'https://site.example' + CALLBACK_PATH }, outboundService },
  ] });
  try {
    const db = await mf.getD1Database('DB', 'site');
    for (const file of readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort()) {
      for (const sql of readFileSync(`drizzle/${file}`, 'utf8').split('--> statement-breakpoint').filter(s => s.trim())) await db.prepare(sql).run();
    }
    const owner = 'private-owner';
    await db.prepare('INSERT INTO connections VALUES (?, ?, ?)').bind(owner, await seal('refresh', encryption, owner), Date.now()).run();
    await db.prepare('INSERT INTO calendars VALUES (?, ?, ?, 1, ?)').bind(owner, 'cal', 'Personal', 'grant').run();
    await db.prepare("INSERT INTO watches (id, owner, calendar_id, generation, token_hash, resource_id, expiration, status) VALUES ('watch', ?, 'cal', 'grant', 'hash', 'resource', ?, 'active')").bind(owner, Date.now() + 3600_000).run();
    const resync = await mf.dispatchFetch('https://site.example/api/calendars/resync', { method: 'POST', headers: { origin: 'https://site.example', 'oai-authenticated-user-id': owner }, body: JSON.stringify({ calendarId: 'cal' }) });
    assert.equal(resync.status, 200, await resync.text()); assert.equal(registrationCount, 1);
    // The pending snapshot is not the scheduler's source of truth.
    await db.prepare('DELETE FROM events').run();
    await waitFor(async () => Boolean(await db.prepare('SELECT id FROM occurrence_outbox').first()));
    assert.equal(lookup, 1);
    const row = await db.prepare('SELECT * FROM occurrence_outbox').first<{due_at: number; created_at: number; payload: string}>();
    assert.equal(row!.due_at, dueAt); assert.ok(row!.created_at >= dueAt); assert.ok(row!.created_at - dueAt < 60_000);
    assert.equal(JSON.parse(row!.payload).title, event.summary);
  } finally { await mf.dispose(); }
});
