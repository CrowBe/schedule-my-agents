import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarFixture } from './helpers/calendar-fixture.ts';
import { CalendarService } from '../lib/calendar/service.ts';
import { CONVERGENCE_INTERVAL_MS, WATCH_RENEWAL_MARGIN_MS } from '../lib/calendar/maintenance.ts';
import type { CallbackTransport } from '../lib/calendar/subscriptions.ts';
import type { CalendarEvent, WriteBackAction } from '../lib/calendar/types.ts';

const ADMIN_SECRET = 'admin-secret-e2e-0123456789';
const MCP_TOKEN = 'mcp-token-e2e-9876543210';
const WEBHOOK_SECRET = 'whsec_' + btoa('w'.repeat(32));
const AGENT_EMAIL = 'agent+review@example.com';
const OWNER_EMAIL = 'owner@example.com';
const EXTERNAL_EMAIL = 'colleague@example.com';

test('combined E2E: self-hosted auth, multi-phase agent lifecycle, 366d invite discovery, write-back, and unattended maintenance', async () => {
  const f = calendarFixture('google');
  // Switch from proxy header mode to strict self-hosted auth mode.
  delete f.env.TRUST_PROXY_AUTH_HEADER;
  f.env.OWNER_ID = 'owner';
  f.env.ADMIN_SECRET = ADMIN_SECRET;
  f.env.MCP_AUTH_TOKEN = MCP_TOKEN;
  f.env.MCP_EVENTS_READY = 'true';
  f.env.GOOGLE_WEBHOOK_VERIFIED = 'true';
  await f.store.run('UPDATE connections SET owner_email = ? WHERE owner = ?', OWNER_EMAIL, 'owner');

  let watchCount = 0;
  let watchExpiry = f.now() + WATCH_RENEWAL_MARGIN_MS - 1_000; // within renewal margin
  const writeBacks: { calendarId: string; eventId: string; action: WriteBackAction }[] = [];
  // Event scheduled 14 days out (beyond 7-day syncEvents snapshot, within 366-day alarm horizon).
  const farStart = f.now() + 14 * 86400_000;
  const farEvent: CalendarEvent = {
    id: 'calendar:far-event', calendarId: 'calendar', provider: 'google', providerEventId: 'far-event',
    title: 'Quarterly audit', description: 'Check open issues', start: new Date(farStart).toISOString(),
    status: 'confirmed', organizerEmail: EXTERNAL_EMAIL, attendees: [{ email: AGENT_EMAIL }],
  };

  f.provider.discoverCalendars = async () => [{ id: 'calendar', summary: 'Primary', accessRole: 'owner', primary: true }];
  f.provider.watchCalendar = async (_calendarId, id, token) => {
    watchCount++;
    watchExpiry = f.now() + 7 * 86400_000;
    return { id, token, resourceId: `res-${watchCount}`, expiration: watchExpiry };
  };
  f.provider.stopWatchingCalendar = async () => {};
  f.provider.syncEvents = async () => []; // 7-day snapshot empty
  f.provider.alarmCandidates = async () => [farEvent]; // 366-day horizon returns the 14-day event
  f.provider.getOccurrence = async (_cal, id) => id === farEvent.providerEventId ? farEvent : null;
  f.provider.applyWriteBack = async (calendarId, eventId, action, authorize) => {
    if (authorize) await authorize(farEvent);
    writeBacks.push({ calendarId, eventId, action });
    return { applied: true, kind: action.kind };
  };

  const delivered: { name: string; data: Record<string, unknown> }[] = [];
  const transport: CallbackTransport = {
    async post(_url, body) {
      const payload = JSON.parse(body);
      if (payload.type === 'verification') return Response.json({ challenge: payload.challenge });
      delivered.push(payload);
      return new Response(null, { status: 204 });
    },
  };

  const service = () => new CalendarService(f.env, {
    http: async (_url, init) => {
      const job = JSON.parse(String(init?.body));
      f.jobs.push(job);
      return Response.json({ registered: true, id: job.id });
    },
    now: f.now,
    provider: async () => f.provider,
    callbackTransport: transport,
  });

  // 1. Direct CalendarService.handle fails closed even with spoofed x-authenticated-owner.
  const spoofed = await service().handle(new Request(f.env.SITE_ORIGIN + '/api/status', {
    headers: { 'x-authenticated-owner': 'owner' },
  }));
  assert.equal(spoofed.status, 401);

  // MCP token cannot access admin /api/* endpoints.
  const mcpOnAdmin = await service().handle(new Request(f.env.SITE_ORIGIN + '/api/status', {
    headers: { authorization: `Bearer ${MCP_TOKEN}` },
  }));
  assert.equal(mcpOnAdmin.status, 401);

  // 2. Self-hosted browser login via /api/auth/login yields a signed cookie.
  const login = await service().handle(new Request(f.env.SITE_ORIGIN + '/api/auth/login', {
    method: 'POST',
    headers: { origin: f.env.SITE_ORIGIN!, 'content-type': 'application/json' },
    body: JSON.stringify({ secret: ADMIN_SECRET }),
  }));
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];

  // Admin session cookie cannot access POST /mcp.
  const adminOnMcp = await service().handle(new Request(f.env.SITE_ORIGIN + '/mcp', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }));
  assert.equal(adminOnMcp.status, 401);

  const adminCall = (path: string, body?: unknown) => service().handle(new Request(f.env.SITE_ORIGIN + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, origin: f.env.SITE_ORIGIN!, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const mcpCall = async (method: string, params?: object) => {
    const res = await service().handle(new Request(f.env.SITE_ORIGIN + '/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${MCP_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }));
    assert.equal(res.status, 200);
    return res.json() as Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }>;
  };

  // 3. Configure agent alias, external allowlist, and opt-in write-back using admin session.
  assert.equal((await adminCall('/api/agents/add', { email: AGENT_EMAIL, label: 'Reviewer' })).status, 200);
  assert.equal((await adminCall('/api/allowlist/add', { email: EXTERNAL_EMAIL })).status, 200);
  assert.equal((await adminCall('/api/calendars/write-back', { calendarId: 'calendar', enabled: true })).status, 200);

  // 4. Subscribe to both invitation onboarding and 10-minute lead-time starting via MCP_AUTH_TOKEN.
  for (const params of [
    { name: 'calendar.event.invited', arguments: { calendarId: 'calendar', agentEmail: AGENT_EMAIL }, delivery: { mode: 'webhook', url: 'https://host.example/hook', secret: WEBHOOK_SECRET } },
    { name: 'calendar.event.starting', arguments: { calendarId: 'calendar', agentEmail: AGENT_EMAIL, leadTimeMinutes: 10 }, delivery: { mode: 'webhook', url: 'https://host.example/hook', secret: WEBHOOK_SECRET } },
  ]) {
    const sub = await mcpCall('events/subscribe', params);
    assert.ok(sub.result?.id, JSON.stringify(sub));
  }

  // 5. Seed an expiring watch and run owner-scoped maintenance via POST /api/maintenance/run.
  await f.store.run(`INSERT INTO watches (id, owner, calendar_id, generation, token_hash, resource_id, expiration, status, provider_id, connection_id)
    VALUES ('expiring-watch', 'owner', 'calendar', 'grant', 'hash', 'res-0', ?, 'active', 'google', 'connection-google')`, watchExpiry);
  const maint1 = await adminCall('/api/maintenance/run', {});
  assert.equal(maint1.status, 200);
  const summary1 = await maint1.json() as { watchesRenewed: number; calendarsConverged: number; failures: number };
  assert.equal(summary1.watchesRenewed, 1);
  assert.equal(summary1.failures, 0);
  assert.equal(watchCount, 1);

  // 6. Renewal synced and discovered the 14-day-out allowlisted external invite immediately!
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].name, 'calendar.event.invited');
  assert.equal(delivered[0].data.agentEmail, AGENT_EMAIL);
  assert.equal((delivered[0].data.provenance as { requiresOwnerApproval: boolean }).requiresOwnerApproval, true);
  assert.equal((delivered[0].data.provenance as { ownerApproved: boolean }).ownerApproved, false);

  const status = await (await adminCall('/api/status')).json() as { invitations: { id: string; approval_status: string }[] };
  assert.equal(status.invitations.length, 1);
  assert.equal(status.invitations[0].approval_status, 'pending');

  // 7. Approve the external invitation via admin session, advance to 10 minutes before the 14-day event,
  // refresh the finite 24-hour MCP subscription as a real host does, and wake the lead-time alarm.
  assert.equal((await adminCall('/api/invitations/approve', { invitationId: status.invitations[0].id })).status, 200);
  const leadJob = f.jobs.find(job => job.dueAt === farStart - 10 * 60_000);
  assert.ok(leadJob, 'expected 10-minute lead-time alarm for 14-day-out event');
  f.setNow(leadJob.dueAt - 60_000);
  assert.ok((await mcpCall('events/subscribe', {
    name: 'calendar.event.starting',
    arguments: { calendarId: 'calendar', agentEmail: AGENT_EMAIL, leadTimeMinutes: 10 },
    delivery: { mode: 'webhook', url: 'https://host.example/hook', secret: WEBHOOK_SECRET },
  })).result?.id);
  f.setNow(leadJob.dueAt);
  const wakeRes = await f.wake(leadJob, transport);
  assert.equal(wakeRes.status, 204);
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].name, 'calendar.event.starting');
  assert.equal(delivered[1].data.leadTimeMinutes, 10);
  assert.equal((delivered[1].data.provenance as { ownerApproved: boolean }).ownerApproved, true);

  // 8. Agent host sends scoped write-back (RSVP + run note) using MCP_AUTH_TOKEN.
  const rsvp = await mcpCall('tools/call', { name: 'calendar_rsvp', arguments: { calendarId: 'calendar', eventId: 'far-event', agentEmail: AGENT_EMAIL, responseStatus: 'accepted' } });
  assert.equal(rsvp.result?.isError, undefined);
  const note = await mcpCall('tools/call', { name: 'calendar_run_note', arguments: { calendarId: 'calendar', eventId: 'far-event', agentEmail: AGENT_EMAIL, runStatus: 'completed', note: 'All checks green' } });
  assert.equal(note.result?.isError, undefined);
  assert.equal(writeBacks.length, 2);

  // 9. After 14 days the renewed 7-day watch has expired, so maintenance renews it automatically.
  const summary2 = await service().runMaintenance();
  assert.equal(summary2.watchesRenewed, 1);
  assert.equal(summary2.failures, 0);
  assert.equal(watchCount, 2);

  // 10. Advancing past the 15-minute convergence interval causes runMaintenance() to converge missed pushes.
  f.setNow(f.now() + CONVERGENCE_INTERVAL_MS + 1_000);
  const summary3 = await service().runMaintenance();
  assert.equal(summary3.watchesRenewed, 0);
  assert.equal(summary3.calendarsConverged, 1);
  assert.equal(summary3.failures, 0);
});
