import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { CalendarService } from '../lib/calendar/service.ts';
import { GoogleCalendar, normalize, SCOPES } from '../lib/calendar/google.ts';
import { open } from '../lib/calendar/crypto.ts';
import { Store } from '../lib/calendar/store.ts';
import type { CalendarProvider, Environment, Statement, CalendarEvent } from '../lib/calendar/types.ts';
function fixture() {
  const sql = new DatabaseSync(':memory:');
  for (const file of readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort()) sql.exec(readFileSync(`drizzle/${file}`, 'utf8'));
  class Prepared implements Statement {
    values: SQLInputValue[] = [];
    constructor(private query: string) {}
    bind(...values: unknown[]) { this.values = values as SQLInputValue[]; return this; }
    async first<T>() { return (sql.prepare(this.query).get(...this.values) ?? null) as T | null; }
    async all<T>() { return { results: sql.prepare(this.query).all(...this.values) as T[] }; }
    async run() { return sql.prepare(this.query).run(...this.values); }
  }
  const DB = { prepare: (q: string) => new Prepared(q), async batch(statements: Statement[]) {
    sql.exec('BEGIN'); try { for (const statement of statements) await statement.run(); sql.exec('COMMIT'); }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  } };
  const env: Environment = { DB, SITE_ORIGIN: 'https://example.chatgpt.site', GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', TOKEN_ENCRYPTION_KEY: btoa('a'.repeat(32)), GOOGLE_WEBHOOK_VERIFIED: 'true' };
  const now = Date.parse('2026-10-04T12:00:00Z');
  let calendars = [{ id: 'personal', summary: 'Personal', accessRole: 'owner' }, { id: 'work', summary: 'Work', accessRole: 'reader' }];
  let events: CalendarEvent[] = [normalize('personal', { id: 'event1', summary: 'Review Weave', description: 'Untrusted instruction', start: { dateTime: '2026-10-04T13:00:00Z' } })!];
  const channels: { calendarId: string; id: string; token: string; address: string }[] = [];
  const stops: string[] = [];
  const syncs: string[] = [];
  const provider: CalendarProvider = {
    async discoverCalendars() { return calendars; },
    async watchCalendar(calendarId, id, token, address) { channels.push({calendarId, id, token, address}); return { id, token, resourceId: `resource-${id}`, expiration: now + 86400_000 }; },
    async stopWatchingCalendar(id) { stops.push(id); },
    async syncEvents(id) { syncs.push(id); return events; },
  };
  const service = () => new CalendarService(env, { provider: async () => provider, now: () => now });
  async function request(path: string, body?: unknown, owner = 'alice') {
    return service().handle(new Request(env.SITE_ORIGIN + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'oai-authenticated-user-id': owner, origin: env.SITE_ORIGIN!, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
  }
  async function webhook(channel = channels[0], overrides: Record<string, string> = {}) {
    return service().handle(new Request(env.SITE_ORIGIN + '/api/google/webhook', { method: 'POST', headers: { 'x-goog-channel-id': channel.id, 'x-goog-channel-token': channel.token, 'x-goog-resource-id': `resource-${channel.id}`, 'x-goog-resource-state': 'exists', 'x-goog-message-number': '2', ...overrides } }));
  }
  return {sql, env, now, provider, channels, stops, syncs, request, webhook, service, setCalendars: (v: typeof calendars) => { calendars = v; }, setEvents: (v: CalendarEvent[]) => { events = v; }};
}
test('discovery → consent → watch → authenticated push → canonical persisted events', async () => {
  const f = fixture();
  const discovered = JSON.parse(await (await f.request('/api/calendars')).text());
  assert.ok(discovered.calendars.every((c: {enabled: boolean}) => !c.enabled));
  assert.equal(f.channels.length, 0);
  assert.equal((await f.request('/api/calendars/watch', {calendarId: 'personal'})).status, 403);
  assert.equal((await f.request('/api/calendars/enable', {calendarId: 'personal'})).status, 200);
  assert.equal((await f.request('/api/calendars/watch', {calendarId: 'personal'})).status, 200);
  assert.equal(f.channels.length, 1); assert.equal(f.channels[0].calendarId, 'personal');
  const event = normalize('personal', {id: 'event2', summary: 'Updated', start: { dateTime: '2026-10-04T14:00:00Z' } })!;
  f.setEvents([event]); assert.equal((await f.webhook()).status, 204);
  assert.deepEqual(JSON.parse(f.sql.prepare('SELECT payload FROM events').get()!.payload as string), JSON.parse(JSON.stringify(event)));
  assert.equal(f.sql.prepare("SELECT count(*) n FROM events WHERE calendar_id = 'work'").get()!.n, 0);
  const restarted = new CalendarService(f.env, { provider: async () => f.provider });
  const status = JSON.parse(await (await restarted.handle(new Request(f.env.SITE_ORIGIN + '/api/status', { headers: {'oai-authenticated-user-id': 'alice'} }))).text());
  assert.equal(status.enabled[0].calendar_id, 'personal');
});
test('newly shared calendars fail closed; enable requires actual calendar access', async () => {
  const f = fixture(); await f.request('/api/calendars/enable', {calendarId: 'personal'});
  f.setCalendars([{id:'shared',summary:'New shared',accessRole:'reader'}, {id:'personal',summary:'Personal',accessRole:'owner'}]);
  const data = JSON.parse(await (await f.request('/api/calendars')).text()); assert.equal(data.calendars[0].enabled, false);
  assert.equal((await f.request('/api/calendars/watch', {calendarId:'shared'})).status, 403);
  assert.equal((await f.request('/api/calendars/enable', {calendarId:'invented'})).status, 403);
});
test('user isolation applies to watches, MCP discovery and subscriptions', async () => {
  const f = fixture(); await f.request('/api/calendars/enable', {calendarId:'personal'});
  assert.equal((await f.request('/api/calendars/watch', {calendarId:'personal'}, 'bob')).status, 403);
  const denied = JSON.parse(await (await f.request('/mcp', {id:1,method:'events/subscribe',params:{name:'calendar.event.starting',arguments:{calendarId:'personal'},delivery:{mode:'webhook',url:'https://receiver.example.com/callback',secret:'whsec_'+btoa('s'.repeat(32))}}}, 'bob')).text()); assert.equal(denied.error.code, -32001);
  const tools = JSON.parse(await (await f.request('/mcp', {id:2,method:'tools/call',params:{name:'enabled_calendars'}}, 'bob')).text()); assert.equal(tools.result.content[0].text, '[]');
});
test('forged, wrong-resource, replayed and expired notifications do not synchronize', async () => {
  const f = fixture(); await f.request('/api/calendars/enable', {calendarId:'personal'}); await f.request('/api/calendars/watch', {calendarId:'personal'});
  assert.equal((await f.webhook(undefined, {'x-goog-channel-token':'forged'})).status, 403);
  assert.equal((await f.webhook(undefined, {'x-goog-resource-id':'other'})).status, 403);
  assert.equal((await f.webhook()).status, 204); const count = f.syncs.length;
  assert.equal((await f.webhook()).status, 204); assert.equal(f.syncs.length, count);
  f.sql.prepare('UPDATE watches SET expiration = ?').run(f.now - 1);
  assert.equal((await f.webhook()).status, 403); assert.equal(f.syncs.length, count);
});
test('disable deletes content and rejects late notifications; renewal stops old channel', async () => {
  const f = fixture(); await f.request('/api/calendars/enable', {calendarId:'personal'}); await f.request('/api/calendars/watch', {calendarId:'personal'});
  await f.request('/api/calendars/watch', {calendarId:'personal'}); assert.ok(f.stops.includes(f.channels[0].id)); assert.equal((await f.webhook(f.channels[0])).status, 403);
  await f.request('/api/calendars/disable', {calendarId:'personal'});
  assert.equal(f.sql.prepare('SELECT count(*) n FROM events').get()!.n, 0);
  assert.equal((await f.webhook(f.channels[1])).status, 403);
});
test('consent revocation during watch creation cleans up provider watch', async () => {
  const f = fixture(); await f.request('/api/calendars/enable', {calendarId:'personal'});
  const watch = f.provider.watchCalendar;
  f.provider.watchCalendar = async (...args) => { const result = await watch(...args); await f.request('/api/calendars/disable', {calendarId:'personal'}); return result; };
  assert.equal((await f.request('/api/calendars/watch', {calendarId:'personal'})).status, 403);
  assert.ok(f.stops.includes(f.channels[0].id)); assert.equal(f.sql.prepare('SELECT count(*) n FROM events').get()!.n, 0);
});
test('revocation during synchronization cannot repopulate events', async () => {
  const f = fixture(); await f.request('/api/calendars/enable', {calendarId:'personal'});
  const sync = f.provider.syncEvents;
  f.provider.syncEvents = async (...args) => { const events = await sync(...args); await new Store(f.env.DB).revoke('alice','personal','revoked'); return events; };
  await f.request('/api/calendars/watch', {calendarId:'personal'});
  assert.equal(f.sql.prepare('SELECT count(*) n FROM events').get()!.n, 0);
});
test('initial sync may arrive before Google watch response', async () => {
  const f = fixture(); await f.request('/api/calendars/enable', {calendarId:'personal'});
  const watch = f.provider.watchCalendar;
  f.provider.watchCalendar = async (...args) => { const result = await watch(...args); assert.equal((await f.webhook(f.channels[0], {'x-goog-resource-state':'sync','x-goog-message-number':'1'})).status, 204); return result; };
  assert.equal((await f.request('/api/calendars/watch', {calendarId:'personal'})).status, 200); assert.equal(f.syncs.length, 1);
});
test('unverified hosted ingress and event-start delivery fail closed', async () => {
  const f = fixture(); f.env.GOOGLE_WEBHOOK_VERIFIED = 'false'; await f.request('/api/calendars/enable', {calendarId:'personal'});
  assert.equal((await f.request('/api/calendars/watch', {calendarId:'personal'})).status, 503); assert.equal(f.channels.length,0);
  const events = JSON.parse(await (await f.request('/mcp', {id:1,method:'events/list'})).text()); assert.deepEqual(events.result.events, []);
  await f.env.DB!.prepare("INSERT INTO connections VALUES ('alice','encrypted',0)").run();
  const subscribed = JSON.parse(await (await f.request('/mcp', {id:2,method:'events/subscribe',params:{name:'calendar.event.starting',arguments:{calendarId:'personal'},delivery:{mode:'webhook',url:'https://receiver.example.com/callback',secret:'whsec_'+btoa('s'.repeat(32))}}})).text()); assert.equal(subscribed.error.code,-32015); assert.equal(subscribed.error.data.reason,'transport_unavailable');
});
test('CSRF and missing identity are rejected', async () => {
  const f=fixture();
  assert.equal((await f.request('/api/status',undefined,'')).status,401);
  assert.equal((await f.service().handle(new Request(f.env.SITE_ORIGIN+'/api/calendars/enable',{method:'POST',headers:{origin:'https://evil.example','oai-authenticated-user-id':'alice'},body:JSON.stringify({calendarId:'personal'})}))).status,403);
});
test('OAuth PKCE, encrypted offline token, cookie/principal binding and replay rejection', async () => {
  const f=fixture(); let exchange=0;
  const service = new CalendarService(f.env, {now:()=>f.now,http: async (_url, init) => {
    const body=init!.body as URLSearchParams; assert.ok(body.get('code_verifier')); assert.equal(body.get('client_secret'),'secret'); exchange++;
    return Response.json({access_token:'access',refresh_token:'refresh-private',scope:SCOPES.join(' ')});
  }});
  const connected=await service.handle(new Request(f.env.SITE_ORIGIN+'/api/google/connect',{method:'POST',headers:{origin:f.env.SITE_ORIGIN!,'oai-authenticated-user-id':'alice'}}));
  const location = new URL(connected.headers.get('location')!); assert.equal(location.searchParams.get('code_challenge_method'),'S256');
  const state=location.searchParams.get('state')!;
  const callback=(owner='alice',cookie=state) => service.handle(new Request(f.env.SITE_ORIGIN+`/api/google/callback?state=${state}&code=code`,{headers:{'oai-authenticated-user-id':owner,cookie:`calendar_oauth=${cookie}`}}));
  assert.equal((await callback('bob')).status,400); assert.equal((await callback('alice','wrong')).status,400); assert.equal(exchange,0);
  assert.equal((await callback()).status,303); assert.equal((await callback()).status,400); assert.equal(exchange,1);
  const encrypted=f.sql.prepare('SELECT refresh_token FROM connections').get()!.refresh_token as string;
  assert.ok(!encrypted.includes('refresh-private')); assert.equal(await open(encrypted,f.env.TOKEN_ENCRYPTION_KEY,'alice'),'refresh-private'); await assert.rejects(open(encrypted,f.env.TOKEN_ENCRYPTION_KEY,'bob'));
});
test('disconnect revokes local data even if provider credentials no longer work',async()=>{
  const f=fixture(); await f.request('/api/calendars/enable',{calendarId:'personal'}); await f.request('/api/calendars/watch',{calendarId:'personal'});
  const service=new CalendarService(f.env,{provider:async()=>{throw new Error('revoked');},now:()=>f.now});
  const result=await service.handle(new Request(f.env.SITE_ORIGIN+'/api/google/disconnect',{method:'POST',headers:{origin:f.env.SITE_ORIGIN!,'oai-authenticated-user-id':'alice'}}));
  assert.equal(result.status,200); assert.equal((await f.webhook()).status,403); assert.equal(f.sql.prepare('SELECT count(*) n FROM calendars').get()!.n,0);
});
test('Google adapter follows pagination, expands recurrence and limits stored fields',async()=>{
  const calls:string[]=[];
  const adapter=new GoogleCalendar('access',async(url)=>{ calls.push(String(url)); const parsed=new URL(String(url)); assert.equal(parsed.searchParams.get('singleEvents'),'true'); assert.ok(parsed.searchParams.get('timeMax')); return Response.json(parsed.searchParams.has('pageToken')? {items:[{id:'cancelled',status:'cancelled'},{id:'all-day',start:{date:'2026-10-05'}}]} : {items:[{id:'instance1',summary:'Review',attendees:[{email:'private'}],start:{dateTime:'2026-10-04T13:00:00Z'}}],nextPageToken:'next'}); });
  const events=await adapter.syncEvents('personal',Date.parse('2026-10-04T12:00:00Z')); assert.equal(events.length,1); assert.equal(calls.length,2); assert.ok(!JSON.stringify(events).includes('attendees'));
});

test('failed push retains snapshot and message cursor; explicit recovery fetches final provider state', async () => {
  const f = fixture();
  await f.request('/api/calendars/enable', { calendarId: 'personal' });
  await f.request('/api/calendars/watch', { calendarId: 'personal' });
  await f.webhook(undefined, { 'x-goog-message-number': '8' });
  const sync = f.provider.syncEvents;
  f.provider.syncEvents = async () => { throw new Error('provider unavailable'); };
  assert.equal((await f.webhook(undefined, { 'x-goog-message-number': '12' })).status, 503);
  const row = f.sql.prepare('SELECT last_message, sync_failed, sync_until FROM watches').get()!;
  assert.equal(row.last_message, '8'); assert.equal(row.sync_failed, 1); assert.equal(row.sync_until, 0);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM events').get()!.n, 1);
  const status = await (await f.request('/api/status')).json() as { watches: { sync_failed: number }[] };
  assert.equal(status.watches[0].sync_failed, 1);
  f.provider.syncEvents = sync;
  f.setEvents([]); // The provider's final state includes cancellation, even without a retry.
  assert.equal((await f.request('/api/calendars/resync', { calendarId: 'personal' })).status, 200);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM events').get()!.n, 0);
  assert.equal(f.sql.prepare('SELECT sync_failed FROM watches').get()!.sync_failed, 0);
  const count = f.syncs.length;
  assert.equal((await f.webhook(undefined, { 'x-goog-message-number': '7' })).status, 204);
  assert.equal(f.syncs.length, count);
  assert.equal((await f.webhook(undefined, { 'x-goog-message-number': '12' })).status, 204);
  assert.equal(f.sql.prepare('SELECT last_message FROM watches').get()!.last_message, '12');
});
test('explicit recovery requires current owner, origin, grant and unexpired watch', async () => {
  const f = fixture();
  await f.request('/api/calendars/enable', { calendarId: 'personal' });
  assert.equal((await f.request('/api/calendars/resync', { calendarId: 'personal' })).status, 409);
  await f.request('/api/calendars/watch', { calendarId: 'personal' });
  assert.equal((await f.request('/api/calendars/resync', { calendarId: 'personal' }, 'bob')).status, 403);
  assert.equal((await f.request('/api/calendars/resync', { calendarId: 'personal' }, '')).status, 401);
  assert.equal((await f.service().handle(new Request(f.env.SITE_ORIGIN + '/api/calendars/resync', {
    method: 'POST', headers: { origin: 'https://evil.example', 'oai-authenticated-user-id': 'alice' }, body: JSON.stringify({ calendarId: 'personal' }),
  }))).status, 403);
  f.sql.prepare('UPDATE watches SET expiration = ?').run(f.now - 1);
  assert.equal((await f.request('/api/calendars/resync', { calendarId: 'personal' })).status, 409);
  await f.request('/api/calendars/disable', { calendarId: 'personal' });
  assert.equal((await f.request('/api/calendars/resync', { calendarId: 'personal' })).status, 403);
});
test('revocation during explicit recovery cannot restore snapshot or grant', async () => {
  const f = fixture();
  await f.request('/api/calendars/enable', { calendarId: 'personal' });
  await f.request('/api/calendars/watch', { calendarId: 'personal' });
  f.provider.syncEvents = async () => {
    await f.request('/api/calendars/disable', { calendarId: 'personal' });
    return [normalize('personal', { id: 'late', start: { dateTime: '2026-10-04T14:00:00Z' } })!];
  };
  assert.equal((await f.request('/api/calendars/resync', { calendarId: 'personal' })).status, 403);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM events').get()!.n, 0);
  assert.equal((await f.webhook()).status, 403);
});

test('overlapping notification leaves recovery warning after in-flight snapshot commits', async () => {
  const f = fixture();
  await f.request('/api/calendars/enable', { calendarId: 'personal' });
  await f.request('/api/calendars/watch', { calendarId: 'personal' });
  const sync = f.provider.syncEvents;
  let release!: () => void;
  let entered!: () => void;
  const fetching = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.provider.syncEvents = async (...args) => { entered(); await blocked; return sync(...args); };
  const first = f.webhook(undefined, { 'x-goog-message-number': '5' });
  await fetching;
  assert.equal((await f.webhook(undefined, { 'x-goog-message-number': '9' })).status, 503);
  release();
  assert.equal((await first).status, 204);
  assert.equal(f.sql.prepare('SELECT sync_failed FROM watches').get()!.sync_failed, 1);
  assert.equal(f.sql.prepare('SELECT last_message FROM watches').get()!.last_message, '5');
  f.provider.syncEvents = sync;
  f.setEvents([]);
  assert.equal((await f.request('/api/calendars/resync', { calendarId: 'personal' })).status, 200);
  assert.equal(f.sql.prepare('SELECT sync_failed FROM watches').get()!.sync_failed, 0);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM events').get()!.n, 0);
});

test('active initial notification cannot compete with watch bootstrap sync', async () => {
  const f = fixture();
  await f.request('/api/calendars/enable', { calendarId: 'personal' });
  let initial!: Promise<Response>;
  let delivered = false;
  let enteredFetching = false;
  let entered!: () => void;
  let release!: () => void;
  const fetching = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const sync = f.provider.syncEvents;
  f.provider.syncEvents = async (...args) => { enteredFetching = true; entered(); await blocked; return sync(...args); };
  const prepare = f.env.DB!.prepare;
  f.env.DB!.prepare = query => {
    const statement = prepare(query);
    const first = statement.first.bind(statement);
    statement.first = async <T>() => {
      const row = await first<T>();
      if (query === 'SELECT * FROM watches WHERE id = ?' && (row as { status?: string })?.status === 'active' && !delivered) {
        delivered = true;
        initial = f.webhook(undefined, { 'x-goog-resource-state': 'sync', 'x-goog-message-number': '1' });
        await Promise.race([fetching, initial]);
        if (!enteredFetching) release();
      }
      return row;
    };
    return statement;
  };
  const started = await f.request('/api/calendars/watch', { calendarId: 'personal' });
  release();
  assert.equal(started.status, 200, await started.text());
  assert.equal((await initial).status, 204);
  assert.equal(f.syncs.length, 1);
  assert.equal(f.sql.prepare('SELECT status FROM watches').get()!.status, 'active');
});
