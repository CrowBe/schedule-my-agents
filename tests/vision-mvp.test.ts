import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarFixture } from './helpers/calendar-fixture.ts';
import { open } from '../lib/calendar/crypto.ts';
import type { InvitationRow } from '../lib/calendar/store.ts';
import type { CallbackTransport } from '../lib/calendar/subscriptions.ts';
import type { CalendarEvent, CalendarEventName } from '../lib/calendar/types.ts';

const agentA = 'agent-a@example.com';
const agentB = 'agent-b@example.com';
const guest = 'guest@example.com';
const ownerEmail = 'owner@example.com';
const secret = 'whsec_' + btoa('a'.repeat(32));
type Message = {
  eventId: string; name: CalendarEventName; timestamp: string;
  data: { eventId: string; agentEmail: string; leadTimeMinutes?: number; provenance: {
    organizerEmail?: string; externalInvite: boolean; requiresOwnerApproval: boolean; ownerApproved: boolean;
  } };
};

async function fixture(options: { organizerEmail?: string; agents?: string[]; recurring?: boolean } = {}) {
  const f = calendarFixture('google');
  f.env.MCP_EVENTS_READY = 'true';
  f.env.GOOGLE_WEBHOOK_VERIFIED = 'true';
  await f.store.run('UPDATE connections SET owner_email = ? WHERE owner = ?', ownerEmail, 'owner');
  const start = f.now() + 60 * 60_000;
  let event: CalendarEvent = {
    id: 'event', calendarId: 'calendar', provider: 'google', providerEventId: 'instance-a',
    title: 'Untrusted event title', description: 'Untrusted event description',
    start: new Date(start).toISOString(), status: 'confirmed', organizerEmail: options.organizerEmail ?? ownerEmail,
    attendees: (options.agents ?? [agentA]).map(email => ({ email })),
    ...(options.recurring ? { seriesId: 'series', recurrenceId: 'slot-a' } : {}),
  };
  const nextStart = start + 24 * 60 * 60_000;
  const successor = { ...event, providerEventId: 'instance-b', recurrenceId: 'slot-b', start: new Date(nextStart).toISOString() };
  let nextCalls: number[] = [];
  f.provider.syncEvents = async () => [event];
  f.provider.alarmCandidates = async () => [event];
  f.provider.getOccurrence = async (_calendar, id) => id === event.providerEventId ? event : null;
  f.provider.nextOccurrence = async (_calendar, _series, after) => {
    nextCalls.push(after);
    return Date.parse(successor.start) > after ? successor : null;
  };
  const messages: Message[] = [];
  let respond: (message: Message) => Response = () => new Response(null, { status: 204 });
  const transport: CallbackTransport = {
    async post(_url, body, headers) {
      const payload = JSON.parse(body);
      if (payload.type === 'verification') return Response.json({ challenge: payload.challenge });
      assert.equal(headers['webhook-id'], payload.eventId);
      messages.push(payload as Message);
      return respond(payload as Message);
    },
  };
  async function request(path: string, body?: unknown, owner = 'owner', origin = f.env.SITE_ORIGIN!) {
    return f.service(transport).handle(new Request(f.env.SITE_ORIGIN + path, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'x-authenticated-owner': owner, origin },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
  }
  async function rpc(method: string, params?: object) {
    const response = await request('/mcp', { jsonrpc: '2.0', id: 1, method, params });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ result?: { id?: string; events?: { name: string }[] }; error?: { code: number } }>;
  }
  async function subscribe(name: CalendarEventName, agentEmail?: string, leadTimeMinutes?: number) {
    return rpc('events/subscribe', {
      name, arguments: { calendarId: 'calendar', ...(agentEmail === undefined ? {} : { agentEmail }),
        ...(leadTimeMinutes === undefined ? {} : { leadTimeMinutes }) },
      delivery: { mode: 'webhook', url: 'https://receiver.example/callback', secret },
    });
  }
  async function addAgent(email: string) {
    assert.equal((await request('/api/agents/add', { email, label: 'Agent' })).status, 200);
  }
  await f.store.run(`INSERT INTO watches (id, owner, calendar_id, generation, token_hash, expiration, status, provider_id, connection_id)
    VALUES ('watch', 'owner', 'calendar', 'grant', 'hash', ?, 'active', 'google', 'connection-google')`, f.now() + 6 * 60 * 60_000);
  return {
    ...f, request, rpc, subscribe, addAgent, transport, start, nextStart, messages,
    invitations: () => f.store.listInvitations('owner'),
    edit: (fields: Partial<CalendarEvent>) => { event = { ...event, ...fields }; },
    nextCalls: () => nextCalls,
    resetNextCalls: () => { nextCalls = []; },
    respond: (handler: typeof respond) => { respond = handler; },
    async sync() {
      const result = await request('/api/calendars/resync', { calendarId: 'calendar' });
      assert.equal(result.status, 200, await result.text());
    },
    startingAlarm(offset = 0, occurrenceStart = start) {
      const job = f.jobs.find(entry => entry.dueAt === occurrenceStart - offset * 60_000);
      assert.ok(job);
      return job;
    },
  };
}

test('sync and start route each agent guest independently with signed, scoped payloads', async () => {
  const f = await fixture({ agents: [agentA, agentB] });
  await f.addAgent(' AGENT-A@EXAMPLE.COM ');
  await f.addAgent(agentB);
  assert.deepEqual((await f.rpc('events/list')).result?.events?.map(event => event.name),
    ['calendar.event.invited', 'calendar.event.starting']);
  assert.equal((await f.subscribe('calendar.event.invited', 'missing@example.com')).error?.code, -32001);
  assert.equal((await f.subscribe('calendar.event.starting', agentA, 1441)).error?.code, -32602);
  const ids = new Set();
  for (const event of ['calendar.event.invited', 'calendar.event.starting'] as const) {
    for (const email of [agentA, agentB]) {
      const sub = await f.subscribe(event, email);
      assert.ok(sub.result?.id);
      ids.add(sub.result.id);
    }
  }
  assert.equal(ids.size, 4);
  assert.equal((await f.subscribe('calendar.event.starting', agentA, 0)).result?.id, [...ids][2]);
  await f.sync();
  await f.sync();
  assert.deepEqual(f.messages.map(message => [message.name, message.data.agentEmail]), [
    ['calendar.event.invited', agentA], ['calendar.event.invited', agentB],
  ]);
  assert.equal((await f.invitations()).length, 2);
  f.respond(message => new Response(null, { status: message.data.agentEmail === agentA ? 503 : 204 }));
  const job = f.startingAlarm();
  f.setNow(job.dueAt);
  assert.equal((await f.wake(job, f.transport)).status, 503);
  assert.deepEqual(f.messages.slice(2).map(message => [message.name, message.data.agentEmail]), [
    ['calendar.event.starting', agentA], ['calendar.event.starting', agentB],
  ]);
  assert.equal(new Set(f.messages.map(message => message.eventId)).size, 4);
  for (const { data } of f.messages) assert.deepEqual(data.provenance, {
    organizerEmail: ownerEmail, isOwnerOrganizer: true, externalInvite: false, requiresOwnerApproval: false, ownerApproved: true,
  });
  f.respond(() => new Response(null, { status: 204 }));
  f.setNow(job.dueAt + 2000);
  assert.equal((await f.wake(job, f.transport)).status, 204);
  assert.deepEqual(f.messages[4], f.messages[2]);
});

test('each scoped send re-reads the live attendees after another agent receives its delivery', async () => {
  const f = await fixture({ agents: [agentA, agentB] });
  for (const email of [agentA, agentB]) {
    await f.addAgent(email);
    assert.ok((await f.subscribe('calendar.event.starting', email)).result?.id);
  }
  await f.sync();
  f.respond(message => {
    if (message.data.agentEmail === agentA) f.edit({ attendees: [{ email: agentA }] });
    return new Response(null, { status: 204 });
  });
  const job = f.startingAlarm();
  f.setNow(job.dueAt);
  assert.equal((await f.wake(job, f.transport)).status, 204);
  assert.deepEqual(f.messages.map(message => message.data.agentEmail), [agentA]);
  assert.equal((await f.store.first<{ body: string }>("SELECT body FROM deliveries WHERE status = 'terminal'"))?.body, '');
});

test('lead-time subscription seeds an active watch and advances recurrence at the same offset', async () => {
  const f = await fixture({ recurring: true });
  await f.addAgent(agentA);
  const sub = await f.subscribe('calendar.event.starting', agentA, 15);
  assert.ok(sub.result?.id);
  const regular = f.startingAlarm();
  const job = f.startingAlarm(15);
  assert.notEqual(regular.id, job.id);
  assert.equal(job.expiresAt, job.dueAt + 300_000);
  const decode = async (envelope: string) => JSON.parse(await open(envelope, f.env.ALARM_ENCRYPTION_KEY, 'calendar-alarm:v1'));
  assert.equal((await decode(regular.envelope)).leadTimeMinutes, undefined);
  assert.equal((await decode(job.envelope)).leadTimeMinutes, 15);
  f.setNow(job.dueAt - 1);
  assert.equal((await f.wake(job, f.transport)).status, 409);
  f.setNow(job.dueAt);
  assert.equal((await f.wake(job, f.transport)).status, 204);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].data.leadTimeMinutes, 15);
  assert.equal(f.messages[0].timestamp, new Date(job.dueAt).toISOString());
  assert.deepEqual(f.nextCalls(), [f.start]);
  assert.equal((await decode(f.startingAlarm(15, f.nextStart).envelope)).leadTimeMinutes, 15);
});

test('lead-time seeding skips a recurrence whose lead time already passed and preserves the start alarm', async () => {
  const f = await fixture({ recurring: true });
  await f.addAgent(agentA);
  f.setNow(f.start - 5 * 60_000);
  assert.ok((await f.subscribe('calendar.event.starting', agentA, 15)).result?.id);
  assert.ok(f.startingAlarm());
  assert.ok(f.startingAlarm(15, f.nextStart));
  assert.equal(f.jobs.length, 2);
});

for (const change of ['move', 'cancel', 'remove guest'] as const) {
  test(`live wake suppresses starting after ${change}`, async () => {
    const f = await fixture({ recurring: true });
    await f.addAgent(agentA);
    assert.ok((await f.subscribe('calendar.event.starting', agentA, 15)).result?.id);
    const job = f.startingAlarm(15);
    if (change === 'move') f.edit({ start: new Date(f.start + 600_000).toISOString() });
    if (change === 'cancel') f.edit({ status: 'cancelled' });
    if (change === 'remove guest') f.edit({ attendees: [] });
    f.resetNextCalls();
    f.setNow(job.dueAt);
    assert.equal((await f.wake(job, f.transport)).status, 204);
    assert.equal(f.messages.length, 0);
    assert.equal(f.nextCalls().length, change === 'remove guest' ? 1 : 0);
  });
}

test('unallowlisted external organizers have no snapshot, invitation or starting receipt', async () => {
  const f = await fixture({ organizerEmail: guest });
  await f.addAgent(agentA);
  assert.ok((await f.subscribe('calendar.event.invited', agentA)).result?.id);
  assert.ok((await f.subscribe('calendar.event.starting', agentA)).result?.id);
  assert.ok((await f.subscribe('calendar.event.starting')).result?.id);
  await f.sync();
  assert.deepEqual(await f.invitations(), []);
  assert.deepEqual(await f.store.all('SELECT * FROM events'), []);
  const job = f.startingAlarm();
  f.setNow(job.dueAt);
  assert.equal((await f.wake(job, f.transport)).status, 204);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(await f.store.all('SELECT * FROM occurrence_outbox'), []);
});

for (const revoke of ['reject', 'remove'] as const) {
  test(`allowlisted external invitation requires approval and ${revoke} clears a pending start retry`, async () => {
    const f = await fixture({ organizerEmail: guest });
    await f.addAgent(agentA);
    assert.equal((await f.request('/api/allowlist/add', { email: ' GUEST@EXAMPLE.COM ' })).status, 200);
    assert.ok((await f.subscribe('calendar.event.invited', agentA)).result?.id);
    assert.ok((await f.subscribe('calendar.event.starting', agentA)).result?.id);
    await f.sync();
    const [invitation] = await f.invitations();
    assert.equal(invitation.approval_status, 'pending');
    assert.deepEqual(f.messages[0].data.provenance, {
      organizerEmail: guest, isOwnerOrganizer: false, externalInvite: true, requiresOwnerApproval: true, ownerApproved: false,
    });
    const job = f.startingAlarm();
    f.setNow(job.dueAt);
    assert.equal((await f.wake(job, f.transport)).status, 204);
    assert.equal(f.messages.length, 1);
    assert.equal((await f.request('/api/invitations/approve', { invitationId: invitation.id }, 'other')).status, 404);
    assert.equal((await f.request('/api/invitations/approve', { invitationId: invitation.id })).status, 200);
    f.respond(() => new Response(null, { status: 503 }));
    assert.equal((await f.wake(job, f.transport)).status, 503);
    assert.equal(f.messages[1].data.provenance.ownerApproved, true);
    assert.equal(f.messages[1].data.agentEmail, agentA);
    if (revoke === 'reject') {
      assert.equal((await f.request('/api/invitations/reject', { invitationId: invitation.id })).status, 200);
      assert.equal((await f.invitations())[0].approval_status, 'rejected');
    } else {
      assert.equal((await f.request('/api/allowlist/remove', { email: guest })).status, 200);
      assert.deepEqual(await f.invitations(), []);
    }
    const receipt = await f.store.first<{ status: string; payload: string }>("SELECT status, payload FROM occurrence_outbox WHERE event_name = 'calendar.event.starting'");
    assert.deepEqual({ ...receipt }, { status: 'terminal', payload: '' });
    const pending = await f.store.first<{ status: string; body: string }>("SELECT status, body FROM deliveries WHERE status = 'terminal'");
    assert.deepEqual({ ...pending }, { status: 'terminal', body: '' });
    f.setNow(job.dueAt + 2000);
    assert.equal((await f.wake(job, f.transport)).status, 204);
    assert.equal(f.messages.length, 2);
  });
}

test('invited callback failures retain a restartable receipt and retry with the same signed body', async () => {
  const f = await fixture();
  await f.addAgent(agentA);
  assert.ok((await f.subscribe('calendar.event.invited', agentA)).result?.id);
  f.respond(() => new Response(null, { status: 503 }));
  const dueAt = f.now();
  await f.sync();
  const retry = f.jobs.find(job => job.dueAt === dueAt);
  assert.ok(retry);
  assert.equal((await f.store.first<{ status: string }>('SELECT status FROM deliveries'))?.status, 'pending');
  assert.equal((await f.invitations())[0].notified_at, dueAt);
  f.respond(() => new Response(null, { status: 204 }));
  f.setNow(dueAt + 2000);
  assert.equal((await f.wake(retry, f.transport)).status, 204);
  assert.deepEqual(f.messages, [f.messages[0], f.messages[0]]);
  assert.equal((await f.store.first<{ status: string }>('SELECT status FROM deliveries'))?.status, 'accepted');
});

test('rejecting an external invitation clears its pending onboarding before a retry can send', async () => {
  const f = await fixture({ organizerEmail: guest });
  await f.addAgent(agentA);
  await f.store.addAllowlist('owner', guest, f.now());
  assert.ok((await f.subscribe('calendar.event.invited', agentA)).result?.id);
  f.respond(() => new Response(null, { status: 503 }));
  const dueAt = f.now();
  await f.sync();
  const retry = f.jobs.find(job => job.dueAt === dueAt);
  assert.ok(retry);
  const [invitation] = await f.invitations();
  assert.equal((await f.request('/api/invitations/reject', { invitationId: invitation.id })).status, 200);
  assert.equal((await f.store.first<{ body: string }>('SELECT body FROM deliveries'))?.body, '');
  f.setNow(dueAt + 2000);
  assert.equal((await f.wake(retry, f.transport)).status, 204);
  assert.equal(f.messages.length, 1);
});

test('alias removal revokes scoped content and fences a wake suspended in the provider lookup', async () => {
  const f = await fixture({ agents: [agentA, agentB] });
  await f.addAgent(agentA);
  await f.addAgent(agentB);
  assert.ok((await f.subscribe('calendar.event.invited', agentA)).result?.id);
  assert.ok((await f.subscribe('calendar.event.starting', agentA)).result?.id);
  assert.ok((await f.subscribe('calendar.event.starting', agentB)).result?.id);
  f.respond(message => new Response(null, { status: message.name.endsWith('invited') ? 503 : 204 }));
  await f.sync();
  const get = f.provider.getOccurrence!;
  let entered!: () => void;
  let release!: () => void;
  const fetching = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  f.provider.getOccurrence = async (...args) => { entered(); await resume; return get(...args); };
  const job = f.startingAlarm();
  f.setNow(job.dueAt);
  const waking = f.wake(job, f.transport);
  await fetching;
  assert.equal((await f.request('/api/agents/remove', { email: agentA }, 'owner', 'https://foreign.example')).status, 403);
  assert.equal((await f.request('/api/agents/remove', { email: agentA })).status, 200);
  for (const table of ['subscriptions', 'subscription_attempts', 'agent_invitations', 'occurrence_outbox']) {
    assert.deepEqual(await f.store.all(`SELECT * FROM ${table} WHERE agent_email = ?`, agentA), []);
  }
  assert.deepEqual(await f.store.all('SELECT * FROM deliveries'), []);
  release();
  assert.equal((await waking).status, 204);
  assert.deepEqual(f.messages.slice(1).map(message => message.data.agentEmail), [agentB]);
});

test('removing and re-adding an alias during callback verification invalidates that attempt', async () => {
  const f = await fixture();
  await f.addAgent(agentA);
  let entered!: () => void;
  let release!: () => void;
  const verifying = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const post = f.transport.post;
  f.transport.post = async (...args) => { entered(); await resume; return post(...args); };
  const subscribing = f.subscribe('calendar.event.starting', agentA);
  await verifying;
  assert.equal((await f.request('/api/agents/remove', { email: agentA })).status, 200);
  await f.addAgent(agentA);
  release();
  assert.equal((await subscribing).error?.code, -32001);
  assert.deepEqual(await f.store.all('SELECT * FROM subscriptions'), []);
});

test('external approval cannot cross organizers or consent generations', async () => {
  const f = await fixture({ organizerEmail: guest });
  await f.addAgent(agentA);
  await f.store.addAllowlist('owner', guest, f.now());
  await f.store.addAllowlist('owner', 'new@example.com', f.now());
  await f.sync();
  const [old] = await f.invitations();
  await f.store.setInvitationApproval('owner', old.id, 'approved', f.now());
  f.edit({ organizerEmail: 'new@example.com' });
  await f.sync();
  const [changed] = await f.invitations();
  assert.notEqual(changed.id, old.id);
  assert.equal(changed.approval_status, 'pending');
  await f.store.revoke('owner', 'calendar', 'new-grant');
  assert.deepEqual(await f.store.all<InvitationRow>('SELECT * FROM agent_invitations'), []);
  await assert.rejects(f.store.setInvitationApproval('owner', changed.id, 'approved', f.now()), /unavailable/);
  await f.store.disconnect('owner');
  assert.equal((await f.store.listAgentAliases('owner')).length, 1);
  assert.equal((await f.store.listAllowlist('owner')).length, 2);
});
