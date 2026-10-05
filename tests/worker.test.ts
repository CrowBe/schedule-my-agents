import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, createFetchMock } from 'miniflare';
import { SCOPES } from '../lib/calendar/google.ts';

for (const scenario of ['success', 'token redirect', 'calendar redirect']) {
test(`Workers OAuth and discovery: ${scenario}`, async () => {
  const { outputFiles } = await build({
    stdin: {
      contents: `import { CalendarService } from './lib/calendar/service.ts';
        export default { fetch(request, env) { return new CalendarService(env).handle(request); } };`,
      resolveDir: process.cwd(),
      sourcefile: 'calendar-worker.ts',
    },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  });
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  fetchMock.get('https://oauth2.googleapis.com')
    .intercept({ method: 'POST', path: '/token' })
    .reply(scenario === 'token redirect' ? 302 : 200,
      JSON.stringify({ access_token: 'access', refresh_token: 'refresh-private', scope: SCOPES.join(' ') }),
      { headers: { location: 'https://unexpected.example/token' } })
    .persist();
  fetchMock.get('https://www.googleapis.com')
    .intercept({ method: 'GET', path: '/calendar/v3/users/me/calendarList?maxResults=250' })
    .reply(scenario === 'calendar redirect' ? 302 : 200,
      JSON.stringify({ items: [{ id: 'personal', summary: 'Personal', accessRole: 'owner' }] }),
      { headers: { location: 'https://unexpected.example/calendar' } });
  const origin = 'https://example.chatgpt.site';
  const mf = new Miniflare({
    modules: true, script: outputFiles[0].text, compatibilityDate: '2026-05-15',
    compatibilityFlags: ['nodejs_compat'], cf: false, fetchMock,
    d1Databases: { DB: 'calendar-test' },
    bindings: { SITE_ORIGIN: origin, GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', TOKEN_ENCRYPTION_KEY: btoa('a'.repeat(32)) },
  });
  try {
    const db = await mf.getD1Database('DB');
    for (const file of readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort()) {
      for (const statement of readFileSync(`drizzle/${file}`, 'utf8').split('--> statement-breakpoint').filter(s => s.trim())) {
        await db.prepare(statement).run();
      }
    }
    const headers = { 'oai-authenticated-user-id': 'alice', origin };
    const start = await mf.dispatchFetch(origin + '/api/google/connect', { method: 'POST', headers, redirect: 'manual' });
    assert.equal(start.status, 303, await start.text());
    const state = new URL(start.headers.get('location')!).searchParams.get('state');
    const callback = await mf.dispatchFetch(origin + `/api/google/callback?state=${state}&code=test-code`, {
      headers: { ...headers, cookie: start.headers.get('set-cookie')!.split(';')[0] }, redirect: 'manual',
    });
    if (scenario === 'token redirect') {
      assert.equal(callback.status, 502, await callback.clone().text());
      assert.equal(await db.prepare('SELECT refresh_token FROM connections').first(), null);
      return;
    }
    assert.equal(callback.status, 303, await callback.text());
    assert.equal(callback.headers.get('location'), '/');
    const row = await db.prepare('SELECT refresh_token FROM connections WHERE owner = ?').bind('alice').first<{refresh_token: string}>();
    assert.ok(row && !row.refresh_token.includes('refresh-private'));
    const calendars = await mf.dispatchFetch(origin + '/api/calendars', { headers });
    if (scenario === 'calendar redirect') {
      assert.equal(calendars.status, 502, await calendars.clone().text());
      return;
    }
    assert.equal(calendars.status, 200, await calendars.clone().text());
    assert.deepEqual(await calendars.json(), { calendars: [{ id: 'personal', summary: 'Personal', accessRole: 'owner', enabled: false }] });
  } finally {
    await mf.dispose();
  }
});
}

test('Workers E2E: OAuth, consent, push create/edit/cancel, failure recovery and revocation', async () => {
  const { outputFiles } = await build({
    stdin: { contents: `import { CalendarService } from './lib/calendar/service.ts';
      export default { fetch(request, env) { return new CalendarService(env).handle(request); } };`,
      resolveDir: process.cwd(), sourcefile: 'calendar-worker.ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  });
  let channel: { id: string; token: string; address: string };
  let items: { id: string; summary: string; start: { dateTime: string } }[] = [];
  let failure = false;
  const outboundService = async (request: Request) => {
    const url = new URL(request.url);
    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token') {
      return Response.json({ access_token: 'access', refresh_token: 'offline', scope: SCOPES.join(' ') });
    }
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(request.headers.get('authorization'), 'Bearer access');
    if (url.pathname === '/calendar/v3/users/me/calendarList') return Response.json({ items: [
      { id: 'personal', summary: 'Personal', accessRole: 'owner' }, { id: 'shared', summary: 'Shared', accessRole: 'reader' },
    ] });
    if (url.pathname === '/calendar/v3/calendars/personal/events/watch' && request.method === 'POST') {
      channel = await request.json() as typeof channel;
      return Response.json({ id: channel.id, resourceId: 'resource', expiration: String(Date.now() + 86400_000) });
    }
    if (url.pathname === '/calendar/v3/calendars/personal/events' && request.method === 'GET') {
      assert.equal(url.searchParams.get('singleEvents'), 'true');
      return Response.json({ items }, { status: failure ? 503 : 200 });
    }
    if (url.pathname === '/calendar/v3/channels/stop') return new Response(null, { status: 204 });
    throw new Error('Unexpected outbound request'); // No external networking in this test.
  };
  const origin = 'https://example.chatgpt.site';
  const mf = new Miniflare({ modules: true, script: outputFiles[0].text,
    compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], cf: false, outboundService,
    d1Databases: { DB: 'full-flow' }, bindings: { SITE_ORIGIN: origin, GOOGLE_CLIENT_ID: 'client',
      GOOGLE_CLIENT_SECRET: 'secret', TOKEN_ENCRYPTION_KEY: btoa('a'.repeat(32)), GOOGLE_WEBHOOK_VERIFIED: 'true' } });
  try {
    const db = await mf.getD1Database('DB');
    for (const file of readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort()) {
      for (const statement of readFileSync(`drizzle/${file}`, 'utf8').split('--> statement-breakpoint').filter(s => s.trim())) await db.prepare(statement).run();
    }
    const headers = { 'oai-authenticated-user-id': 'alice', origin };
    const call = (path: string, body?: unknown) => mf.dispatchFetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
    });
    const connect = await call('/api/google/connect', {});
    assert.equal(connect.status, 303);
    const state = new URL(connect.headers.get('location')!).searchParams.get('state');
    const callback = await mf.dispatchFetch(origin + `/api/google/callback?state=${state}&code=code`, {
      headers: { ...headers, cookie: connect.headers.get('set-cookie')!.split(';')[0] }, redirect: 'manual' });
    assert.equal(callback.status, 303);
    const discovered = await (await call('/api/calendars')).json() as { calendars: { enabled: boolean }[] };
    assert.ok(discovered.calendars.every(c => !c.enabled));
    assert.equal((await call('/api/calendars/enable', { calendarId: 'personal' })).status, 200);
    assert.equal((await call('/api/calendars/watch', { calendarId: 'shared' })).status, 403);
    const started = await call('/api/calendars/watch', { calendarId: 'personal' });
    assert.equal(started.status, 200, await started.text());
    assert.equal(channel!.address, origin + '/api/google/webhook');
    const watch = await db.prepare('SELECT token_hash, resource_id, expiration FROM watches').first<{ token_hash: string; resource_id: string; expiration: number }>();
    assert.ok(watch && watch.token_hash !== channel!.token && watch.resource_id === 'resource' && watch.expiration > Date.now());
    const push = (number: string, extra: Record<string, string> = {}) => mf.dispatchFetch(origin + '/api/google/webhook', {
      method: 'POST', headers: { 'x-goog-channel-id': channel!.id, 'x-goog-channel-token': channel!.token,
        'x-goog-resource-id': 'resource', 'x-goog-resource-state': 'exists', 'x-goog-message-number': number, ...extra },
    });
    assert.equal((await push('1', { 'x-goog-resource-state': 'sync' })).status, 204);
    items = [{ id: 'one', summary: 'Created', start: { dateTime: new Date(Date.now() + 3600_000).toISOString() } }];
    assert.equal((await push('3')).status, 204);
    assert.equal(JSON.parse((await db.prepare('SELECT payload FROM events').first<{ payload: string }>())!.payload).title, 'Created');
    items[0].summary = 'Edited';
    assert.equal((await push('5')).status, 204);
    assert.equal(JSON.parse((await db.prepare('SELECT payload FROM events').first<{ payload: string }>())!.payload).title, 'Edited');
    failure = true;
    assert.equal((await push('8')).status, 502);
    assert.equal((await db.prepare('SELECT last_message, sync_failed FROM watches').first())!.last_message, '5');
    assert.equal((await db.prepare('SELECT sync_failed FROM watches').first())!.sync_failed, 1);
    failure = false; items = [];
    assert.equal((await call('/api/calendars/resync', { calendarId: 'personal' })).status, 200);
    assert.equal(await db.prepare('SELECT payload FROM events').first(), null);
    assert.equal((await push('8')).status, 204);
    assert.equal((await push('5')).status, 204);
    assert.equal((await push('9', { 'x-goog-channel-token': 'forged' })).status, 403);
    assert.equal((await call('/api/calendars/disable', { calendarId: 'personal' })).status, 200);
    assert.equal((await push('10')).status, 403);
    assert.equal(await db.prepare("SELECT * FROM events WHERE calendar_id = 'shared'").first(), null);
    assert.equal((await call('/api/google/disconnect', {})).status, 200);
    assert.equal(await db.prepare('SELECT * FROM connections').first(), null);
  } finally { await mf.dispose(); }
});
