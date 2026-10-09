import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { CalendarService } from '../lib/calendar/service.ts';
import { GoogleCalendar, normalize, SCOPES } from '../lib/calendar/google.ts';
import { open } from '../lib/calendar/crypto.ts';
import { Store } from '../lib/calendar/store.ts';
import type { CalendarProvider, Environment, Statement, CalendarEvent } from '../lib/calendar/types.ts';
import { CALENDAR_APP_URI, CALENDAR_APP_MIME } from '../lib/calendar/setup-contract.ts';
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
  const service = () => new CalendarService(env, { provider: async () => provider, now: () => now, calendarAppHtml: '<!doctype html><title>Calendar settings</title>' });
  async function request(path: string, body?: unknown, owner = 'alice') {
    const headers = new Headers({ 'oai-authenticated-user-id': owner, origin: env.SITE_ORIGIN!, 'content-type': 'application/json' });
    // The fixture is a valid MCP client; invalid envelopes use the raw handler below.
    if (path === '/mcp' && body && typeof body === 'object') {
      const rpc = body as { method: string; params?: { _meta?: Record<string,unknown>; name?: string; uri?: string } };
      body = { jsonrpc: '2.0', ...body };
      const version = rpc.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
      if (typeof version === 'string') { headers.set('MCP-Protocol-Version', version); headers.set('Mcp-Method', rpc.method); }
      if (version && (rpc.params?.name || rpc.params?.uri)) headers.set('Mcp-Name', rpc.params.name ?? rpc.params.uri!);
    }
    return service().handle(new Request(env.SITE_ORIGIN + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) }));
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
test('MCP discovery publishes modern server identity without exposing account data', async () => {
  const f = fixture();
  await f.request('/api/calendars/enable', {calendarId:'personal'});
  const discovered = JSON.parse(await (await f.request('/mcp', {
    jsonrpc:'2.0', id:'discover', method:'server/discover', params:{_meta:{
      'io.modelcontextprotocol/protocolVersion':'2026-07-28',
      'io.modelcontextprotocol/clientInfo':{name:'reference-check',version:'1'},
      'io.modelcontextprotocol/clientCapabilities':{},
    }},
  })).text());
  assert.equal(discovered.id, 'discover');
  assert.equal(discovered.result._meta?.['io.modelcontextprotocol/serverInfo']?.name, 'schedule-my-agents');
  assert.equal(typeof discovered.result._meta?.['io.modelcontextprotocol/serverInfo']?.version, 'string');
  assert.equal(discovered.result.serverInfo, undefined);
  assert.ok(discovered.result.supportedVersions.includes('2026-07-28'));
  assert.deepEqual(discovered.result.capabilities, {tools:{}, resources:{}, extensions:{'io.modelcontextprotocol/ui':{mimeTypes:[CALENDAR_APP_MIME]}}, events:{}});
  assert.ok(!JSON.stringify(discovered).includes('personal'));
  assert.ok(!JSON.stringify(discovered).includes('alice'));
  const legacy = JSON.parse(await (await f.request('/mcp', {jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:'2025-03-26'}})).text());
  assert.equal(legacy.result.serverInfo.name, 'schedule-my-agents');
  assert.equal(legacy.result.protocolVersion, '2025-03-26');
});
test('optional calendar entrypoint and resource open read-only and hide private data from discovery', async () => {
  const f = fixture();
  await f.env.DB!.prepare("INSERT INTO connections VALUES ('alice','encrypted',0)").run();
  const catalog = JSON.parse(await (await f.request('/mcp', {id:1,method:'tools/list'})).text());
  const tool = catalog.result.tools.find((item:{name:string}) => item.name === 'calendar_setup');
  assert.equal(tool._meta.ui.resourceUri, CALENDAR_APP_URI);
  assert.deepEqual(tool._meta.ui.visibility, ['app']);
  assert.deepEqual(tool._meta['openai/ui'].entrypoints, [{type:'global'},{type:'thread'}]);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.openWorldHint, false);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.ok(!JSON.stringify(catalog).includes('encrypted'));
  assert.ok(!JSON.stringify(catalog).includes('alice'));
  const before = f.sql.prepare('SELECT * FROM calendars').all();
  const call = {id:2,method:'tools/call',params:{name:'calendar_setup',arguments:{}}};
  const alice = JSON.parse(await (await f.request('/mcp', call)).text()).result;
  assert.equal(alice.structuredContent, undefined);
  assert.ok(!JSON.stringify(alice.content).includes('Personal'));
  assert.equal(alice._meta.calendarSetup.status.connected, true);
  assert.equal(alice._meta.calendarSetup.calendars.length, 2);
  assert.ok(alice._meta.calendarSetup.calendars.every((c:{enabled:boolean}) => !c.enabled));
  const bob = JSON.parse(await (await f.request('/mcp', call, 'bob')).text()).result;
  assert.equal(bob._meta.calendarSetup.status.connected, false);
  assert.deepEqual(bob._meta.calendarSetup.calendars, []);
  assert.deepEqual(f.sql.prepare('SELECT * FROM calendars').all(), before);
  assert.equal(f.channels.length, 0);
  const resource = JSON.parse(await (await f.request('/mcp',{id:3,method:'resources/read',params:{uri:CALENDAR_APP_URI}})).text()).result.contents[0];
  assert.equal(resource.mimeType, CALENDAR_APP_MIME);
  assert.ok(resource.text.startsWith('<!doctype html>'));
  assert.deepEqual(resource._meta.ui.csp, {connectDomains:[],resourceDomains:[],frameDomains:[]});
  assert.equal(resource._meta['openai/ui'].preferredDisplayMode,'fullscreen');
  assert.ok(!JSON.stringify(resource).includes('alice'));
  assert.equal(JSON.parse(await (await f.request('/mcp',{id:4,method:'resources/read',params:{uri:'file:///etc/passwd'}})).text()).error.code,-32002);
});
test('calendar app actions reuse explicit consent, owner isolation and local revocation', async () => {
  const f = fixture();
  await f.env.DB!.prepare("INSERT INTO connections VALUES ('alice','encrypted',0)").run();
  const action = async (action:string,calendarId?:string,owner='alice') => JSON.parse(await (await f.request('/mcp',{id:1,method:'tools/call',params:{name:'calendar_setup_action',arguments:{action,...(calendarId ? {calendarId} : {})}}},owner)).text()).result;
  assert.equal((await action('watch','personal')).isError,true);
  assert.equal(f.channels.length,0);
  const enabled = await action('enable','personal');
  assert.equal(enabled.structuredContent,undefined);
  assert.equal(enabled._meta.calendarSetup.calendars.find((c:{id:string}) => c.id==='personal').enabled,true);
  assert.equal((await action('watch','personal','bob')).isError,true);
  assert.equal((await action('enable','invented')).isError,true);
  assert.ok(!(await action('watch','personal')).isError);
  assert.equal(f.channels.length,1);
  await action('disable','personal','bob');
  assert.equal(f.sql.prepare("SELECT enabled FROM calendars WHERE owner='alice' AND calendar_id='personal'").get()!.enabled,1);
  assert.ok(!(await action('disable','personal')).isError);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM events').get()!.n,0);
  assert.equal((await f.webhook()).status,403);
  assert.ok(!(await action('disconnect')).isError);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM connections').get()!.n,0);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM calendars WHERE enabled=1').get()!.n,0);
});
test('MCP tool arguments reject undeclared authority before making changes', async () => {
  const f=fixture();
  for (const [name,args] of [['enabled_calendars',{owner:'bob'}],['calendar_setup',{calendarId:'personal'}],['calendar_setup_action',{action:'enable',calendarId:'personal',owner:'bob'}],['calendar_setup_action',{action:'/api/google/connect'}],['calendar_setup_action',{action:'disconnect',calendarId:'personal'}],['calendar_setup_action',{action:'enable'}]] as const) {
    const result=JSON.parse(await (await f.request('/mcp',{id:1,method:'tools/call',params:{name,arguments:args}})).text()).result;
    assert.equal(result.isError,true);
  }
  assert.equal(f.sql.prepare('SELECT count(*) n FROM calendars').get()!.n,0);
  assert.equal(f.channels.length,0);
});
test('MCP transport returns protocol errors and rejects unavailable HTTP methods', async () => {
  const f=fixture();
  const headers={'oai-authenticated-user-id':'alice','content-type':'application/json'};
  const raw=async (body:string, extra:Record<string,string>={}) => f.service().handle(new Request(f.env.SITE_ORIGIN+'/mcp',{method:'POST',headers:{...headers,...extra},body}));
  const malformed=await raw('{'); assert.equal(malformed.status,400); assert.equal(JSON.parse(await malformed.text()).error.code,-32700);
  const invalid=await raw(JSON.stringify({id:1,method:'tools/list'})); assert.equal(invalid.status,400); assert.equal(JSON.parse(await invalid.text()).error.code,-32600);
  const foreign=await raw(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}),{Origin:'https://foreign.example'}); assert.equal(foreign.status,403);
  const notification=await raw(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})); assert.equal(notification.status,202); assert.equal(await notification.text(),'');
  const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}};
  const unknown=await raw(JSON.stringify({jsonrpc:'2.0',id:'unknown',method:'unknown',params:{_meta:meta}}),{'MCP-Protocol-Version':'2026-07-28','Mcp-Method':'unknown'});
  assert.equal(unknown.status,404); assert.equal(JSON.parse(await unknown.text()).error.code,-32601);
  for (const method of ['GET','DELETE']) { const response=await f.service().handle(new Request(f.env.SITE_ORIGIN+'/mcp',{method,headers})); assert.equal(response.status,405); assert.equal(response.headers.get('allow'),'POST'); }
  const unauthenticated=await f.service().handle(new Request(f.env.SITE_ORIGIN+'/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})})); assert.equal(unauthenticated.status,401);
});
test('modern MCP result envelopes declare complete for tools, resources and empty results', async () => {
  const f=fixture();
  const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}};
  for (const [method,params] of [['tools/list',{}],['tools/call',{name:'calendar_setup',arguments:{}}],['resources/list',{}],['resources/read',{uri:CALENDAR_APP_URI}],['resources/templates/list',{}],['ping',{}],['events/list',{}]] as const) {
    const response=await f.request('/mcp',{id:1,method,params:{...params,_meta:meta}});
    assert.equal(response.status,200);
    const result=JSON.parse(await response.text()).result;
    assert.equal(result.resultType,'complete',method);
  }
  const legacy=JSON.parse(await (await f.request('/mcp',{id:2,method:'tools/list'})).text()).result;
  assert.equal(legacy.resultType,undefined);
});
test('MCP calendar tool declares read-only behavior and keeps calls scoped to the owner', async () => {
  const f = fixture();
  await f.request('/api/calendars/enable', {calendarId:'personal'});
  const catalog = JSON.parse(await (await f.request('/mcp', {jsonrpc:'2.0',id:1,method:'tools/list'})).text());
  const tool = catalog.result.tools.find((item: {name:string}) => item.name === 'enabled_calendars');
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.equal(tool.annotations?.destructiveHint, false);
  assert.equal(tool.annotations?.openWorldHint, false);
  assert.equal(tool.annotations?.idempotentHint, true);
  assert.ok(tool.title);
  const before = f.sql.prepare('SELECT * FROM calendars').all();
  const call = {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:tool.name,arguments:{}}};
  const alice = JSON.parse(await (await f.request('/mcp', call)).text());
  const bob = JSON.parse(await (await f.request('/mcp', call, 'bob')).text());
  assert.deepEqual(JSON.parse(alice.result.content[0].text), [{calendarId:'personal',summary:'Personal'}]);
  assert.deepEqual(JSON.parse(bob.result.content[0].text), []);
  assert.deepEqual(f.sql.prepare('SELECT * FROM calendars').all(), before);
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
