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
