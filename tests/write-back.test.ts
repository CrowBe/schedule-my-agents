import assert from 'node:assert/strict';
import test from 'node:test';
import { CalendarService } from '../lib/calendar/service.ts';
import { GoogleCalendar, SCOPES, WRITE_SCOPE } from '../lib/calendar/google.ts';
import { GoogleAuthorization } from '../lib/calendar/google-connection.ts';
import { calendarFixture } from './helpers/calendar-fixture.ts';

const agent = 'agent@example.com';
const owner = 'owner@example.com';
const external = 'external@example.com';

function fixture() {
  const f = calendarFixture('google');
  f.env.GOOGLE_WEBHOOK_VERIFIED = 'true';
  let event = {
    id: 'event', etag: '"revision-1"', summary: 'Review', status: 'confirmed',
    start: { dateTime: new Date(f.now() + 3600_000).toISOString() },
    organizer: { email: owner }, creator: { email: 'CREATOR@EXAMPLE.COM' },
    attendees: [
      { email: 'AGENT@EXAMPLE.COM', responseStatus: 'needsAction', displayName: 'Agent' },
      { email: 'person@example.com', responseStatus: 'tentative', displayName: 'Person', optional: true },
    ],
    description: 'Owner-provided <b>description</b>\nKeep this paragraph.',
    extendedProperties: { private: { userField: 'keep' } },
  };
  const patches: { body: Partial<typeof event>; etag: string | null }[] = [];
  let getCount = 0;
  let getHook: (count: number) => Promise<void> = async () => {};
  const adapter = new GoogleCalendar('calendar-token', async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/calendarList')) {
      return Response.json({ items: [{ id: 'OWNER@EXAMPLE.COM', primary: true, accessRole: 'owner', summary: 'Primary' }] });
    }
    if (path.endsWith('/events') && init?.method !== 'PATCH') return Response.json({ items: [event] });
    assert.ok(path.endsWith('/calendars/calendar/events/event'));
    if (init?.method !== 'PATCH') {
      await getHook(++getCount);
      return Response.json(event);
    }
    const body = JSON.parse(String(init.body)) as Partial<typeof event>;
    patches.push({ body, etag: new Headers(init.headers).get('if-match') });
    event = { ...event, ...body };
    return Response.json(event);
  });
  const service = () => new CalendarService(f.env, { provider: async () => adapter, now: f.now });
  async function request(path: string, body?: object) {
    return service().handle(new Request(f.env.SITE_ORIGIN + path, {
      method: body ? 'POST' : 'GET', headers: { 'x-authenticated-owner': 'owner', origin: f.env.SITE_ORIGIN! },
      body: body ? JSON.stringify(body) : undefined,
    }));
  }
  async function call(name: string, args: object) {
    const response = await request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name, arguments: { calendarId: 'calendar', eventId: 'event', agentEmail: agent, ...args },
    } });
    assert.equal(response.status, 200);
    const { result } = await response.json() as { result: { isError?: boolean; content: { text: string }[] } };
    return result.isError ? { error: result.content[0].text } : JSON.parse(result.content[0].text);
  }
  return {
    ...f, service, request, call, adapter, patches, current: () => event, getCount: () => getCount,
    edit: (update: Partial<typeof event>) => { event = { ...event, ...update }; },
    onGet: (hook: typeof getHook) => { getHook = hook; },
    async enable() {
      assert.equal((await request('/api/calendars/write-back', { calendarId: 'calendar', enabled: true })).status, 200);
    },
    async setUp() {
      assert.equal((await request('/api/calendars')).status, 200);
      assert.equal((await f.store.connection('owner'))?.ownerEmail, owner);
      assert.equal((await request('/api/agents/add', { email: agent, label: 'Worker' })).status, 200);
    },
  };
}

test('Google discovery adopts the primary owner email without granting authority or changing the default write scope', async () => {
  const f = fixture();
  const response = await f.request('/api/calendars');
  assert.deepEqual(await response.json(), {
    calendars: [{ id: 'OWNER@EXAMPLE.COM', primary: true, accessRole: 'owner', summary: 'Primary', enabled: false, writeBackEnabled: false }],
    agentAliases: [], allowlist: [], invitations: [],
  });
  assert.equal((await f.store.connection('owner'))?.ownerEmail, owner);
  assert.equal(await f.store.calendar('owner', 'OWNER@EXAMPLE.COM'), null);
  const grant = await f.store.calendar('owner', 'calendar');
  assert.equal(grant?.write_back_enabled, 0);
  f.env.GOOGLE_CLIENT_ID = 'client';
  f.env.GOOGLE_CLIENT_SECRET = 'secret';
  const google = new GoogleAuthorization(f.env, f.store, async () => { throw new Error('Unexpected exchange'); }, f.now, () => f.env.SITE_ORIGIN!);
  const scopes = async () => new URL((await google.start('owner')).headers.get('location')!).searchParams.get('scope')!.split(' ');
  assert.deepEqual(await scopes(), SCOPES);
  f.env.GOOGLE_WRITE_SCOPE_ENABLED = 'true';
  assert.deepEqual(await scopes(), [...SCOPES, WRITE_SCOPE]);
});

test('RSVP is off by default and updates only the matching guest on an enabled calendar', async () => {
  const f = fixture();
  await f.setUp();
  assert.match((await f.call('calendar_rsvp', { responseStatus: 'accepted' })).error, /disabled/);
  assert.equal(f.getCount(), 0);
  await f.enable();
  const status = await (await f.request('/api/status')).json() as { enabled: { writeBackEnabled: boolean }[] };
  assert.equal(status.enabled[0].writeBackEnabled, true);
  const original = f.current().attendees;
  assert.deepEqual(await f.call('calendar_rsvp', { agentEmail: ' AGENT@EXAMPLE.COM ', responseStatus: 'accepted' }), { applied: true, kind: 'rsvp' });
  assert.deepEqual(f.patches, [{ body: { attendees: [{ ...original[0], responseStatus: 'accepted' }, original[1]] }, etag: '"revision-1"' }]);
  await f.store.revoke('owner', 'calendar', 'new-grant');
  assert.equal((await f.store.calendar('owner', 'calendar'))?.write_back_enabled, 0);
  assert.match((await f.call('calendar_rsvp', { responseStatus: 'declined' })).error, /not enabled/);
  assert.equal(f.patches.length, 1);
});

test('run notes update one delimited line, retain user description and private metadata, and strip controls', async () => {
  const f = fixture();
  await f.setUp();
  await f.enable();
  const description = f.current().description;
  assert.match((await f.call('calendar_run_note', { runStatus: 'started', note: 'x'.repeat(281) })).error, /280/);
  assert.equal(f.patches.length, 0);
  assert.deepEqual(await f.call('calendar_run_note', { runStatus: 'started', note: 'Step\u0000\n <one>' }), { applied: true, kind: 'run_note' });
  assert.equal(f.current().description, description + '\n[agent-status:agent@example.com] started: Step &lt;one&gt;');
  assert.deepEqual(await f.call('calendar_run_note', { runStatus: 'completed', note: 'Done' }), { applied: true, kind: 'run_note' });
  assert.equal(f.current().description, description + '\n[agent-status:agent@example.com] completed: Done');
  const { userField, ...metadata } = f.current().extendedProperties.private as Record<string, string>;
  assert.equal(userField, 'keep');
  const values = Object.values(metadata);
  assert.equal(values.length, 1);
  assert.deepEqual(JSON.parse(values[0]), { runStatus: 'completed', note: 'Done' });
  assert.ok(f.patches.every(patch => patch.body.attendees === undefined));
});

test('write-back rejects unknown aliases, non-guests, cancelled events and extra authority fields', async () => {
  const f = fixture();
  await f.setUp();
  await f.enable();
  assert.match((await f.call('calendar_rsvp', { agentEmail: 'person@example.com', responseStatus: 'accepted' })).error, /not registered/);
  await f.store.addAgentAlias('owner', 'non-guest@example.com', '', f.now());
  assert.match((await f.call('calendar_rsvp', { agentEmail: 'non-guest@example.com', responseStatus: 'accepted' })).error, /not authorized/);
  assert.match((await f.call('calendar_run_note', { runStatus: 'started', description: 'Replace text' })).error, /Unknown write-back argument/);
  f.edit({ status: 'cancelled' });
  assert.match((await f.call('calendar_rsvp', { responseStatus: 'accepted' })).error, /unavailable/);
  assert.deepEqual(f.patches, []);
});

test('write-back requires allowlist plus current invitation approval for an external organizer', async () => {
  const f = fixture();
  await f.setUp();
  await f.enable();
  f.edit({ organizer: { email: external } });
  assert.match((await f.call('calendar_rsvp', { responseStatus: 'declined' })).error, /not authorized/);
  assert.equal((await f.request('/api/allowlist/add', { email: external })).status, 200);
  await f.store.run(`INSERT INTO watches (id, owner, calendar_id, generation, token_hash, expiration, status, provider_id, connection_id)
    VALUES ('watch', 'owner', 'calendar', 'grant', 'hash', ?, 'active', 'google', 'connection-google')`, f.now() + 7200_000);
  // Exercise the real sync and invitation persistence without alarm registration.
  f.env.DISPATCHER_ORIGIN = undefined;
  const sync = await f.request('/api/calendars/resync', { calendarId: 'calendar' });
  assert.equal(sync.status, 200, await sync.text());
  const [invite] = await f.store.listInvitations('owner');
  assert.ok(invite);
  assert.match((await f.call('calendar_rsvp', { responseStatus: 'declined' })).error, /not authorized/);
  assert.equal((await f.request('/api/invitations/approve', { invitationId: invite.id })).status, 200);
  assert.deepEqual(await f.call('calendar_rsvp', { responseStatus: 'declined' }), { applied: true, kind: 'rsvp' });
  assert.equal((await f.request('/api/allowlist/remove', { email: external })).status, 200);
  assert.match((await f.call('calendar_run_note', { runStatus: 'completed' })).error, /not authorized/);
  assert.equal(f.patches.length, 1);
});

for (const change of ['revoke write-back', 'remove alias', 'remove guest', 'change organizer'] as const) {
  test(`Google checks the live event and owner authority after preflight when a race can ${change}`, async () => {
    const f = fixture();
    await f.setUp();
    await f.enable();
    let entered!: () => void;
    let release!: () => void;
    const fetching = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    f.onGet(async count => { if (count === 2) { entered(); await resume; } });
    const writing = f.call('calendar_rsvp', { responseStatus: 'accepted' });
    await fetching;
    if (change === 'revoke write-back') {
      assert.equal((await f.request('/api/calendars/write-back', { calendarId: 'calendar', enabled: false })).status, 200);
    } else if (change === 'remove alias') {
      assert.equal((await f.request('/api/agents/remove', { email: agent })).status, 200);
    } else if (change === 'remove guest') {
      f.edit({ attendees: [] });
    } else {
      f.edit({ organizer: { email: external } });
    }
    release();
    assert.match((await writing).error, /not authorized|not a guest/);
    assert.deepEqual(f.patches, []);
  });
}
