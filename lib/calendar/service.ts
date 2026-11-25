import { Subscriptions, SubscriptionError, eventDefinitions, type CallbackTransport } from './subscriptions.ts';
import { authenticateApi, authenticateMcp, handleAuthRoute, siteOrigin } from './auth.ts';
import { CalendarMaintenance, type RenewalExpectation } from './maintenance.ts';
import { digest, random } from './crypto.ts';
import { type Fetch } from './google.ts';
import { resolveConnectedProvider, registeredAdapter, type ProviderAdapters } from './providers.ts';
import { Store, connectionIdentity, type CalendarConnection, type WatchRow } from './store.ts';
import { AppError, ProviderFailure, type CalendarEvent, type CalendarProvider, type Environment, type WriteBackAction } from './types.ts';
import { LATE_WINDOW } from '../../shared/alarm.ts';
import { Deliveries } from './delivery.ts';
import { attendeeEmails, normalizeEmail, organizer } from './provenance.ts';
import { OccurrenceAlarms } from './alarms.ts';
import { readMcpMessage, mcpErrorResponse, McpProtocolError, SUPPORTED_MCP_VERSIONS, emptyToolArguments } from './mcp-protocol.ts';
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const string = { type: 'string' };
const writeBackFields = { calendarId: string, eventId: string, agentEmail: string };
const tools = [
  ...[
    { name: 'enabled_calendars', title: 'Enabled calendars', description: 'List calendars explicitly enabled by the connected user.' },
    { name: 'agent_aliases', title: 'Agent aliases', description: 'List registered calendar guest aliases.' },
  ].map(tool => ({ ...tool, inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } })),
  {
    name: 'calendar_rsvp', title: 'Set agent RSVP', description: 'Update the matching agent guest RSVP on an authorized occurrence.',
    inputSchema: { type: 'object', properties: { ...writeBackFields, responseStatus: { type: 'string', enum: ['accepted', 'tentative', 'declined'] } },
      required: [...Object.keys(writeBackFields), 'responseStatus'], additionalProperties: false },
  },
  {
    name: 'calendar_run_note', title: 'Set agent run status', description: 'Record a short agent run status on an authorized occurrence.',
    inputSchema: { type: 'object', properties: { ...writeBackFields, runStatus: { type: 'string', enum: ['started', 'completed', 'failed'] },
      note: { type: 'string', maxLength: 280 } }, required: [...Object.keys(writeBackFields), 'runStatus'], additionalProperties: false },
  },
];
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'An object is required.');
  return value as Record<string, unknown>;
}
function requiredId(value: unknown, label: string) {
  if (typeof value !== 'string' || !value || value.length > 1024) throw new AppError(400, `A ${label} is required.`);
  return value;
}
function requiredEmail(value: unknown) {
  const email = normalizeEmail(value);
  if (!email) throw new AppError(400, 'A valid email address is required.');
  return email;
}
export type Dependencies = { callbackTransport?: CallbackTransport; http?: Fetch; now?: () => number; provider?: (owner: string) => Promise<CalendarProvider>; providerAdapters?: ProviderAdapters };
export class CalendarService {
  private env: Environment;
  private dependencies: Dependencies;
  private store: Store;
  private http: Fetch;
  private now: () => number;
  private alarms: OccurrenceAlarms;
  constructor(env: Environment, dependencies: Dependencies = {}) {
    this.env = env; this.dependencies = dependencies;
    const http = dependencies.http ?? fetch;
    this.store = new Store(env.DB); this.http = (input, init) => http(input, init); this.now = dependencies.now ?? Date.now;
    this.alarms = new OccurrenceAlarms(env, this.store, (input, init) => this.http(input, init), this.now, owner => this.provider(owner), dependencies.callbackTransport);
  }
  private providerAuthorization(providerId:string) {return registeredAdapter(this.env,this.store,this.http,providerId,this.dependencies.providerAdapters)?.authorization?.({env:this.env,store:this.store,http:this.http,now:this.now,origin:()=>this.origin()});}
  private async ingressReady(owner:string) {
    const connection=await this.store.connection(owner);
    return registeredAdapter(this.env,this.store,this.http,connection?.providerId??'google',this.dependencies.providerAdapters)?.ingressVerified===true;
  }
  private async eventCatalogReady(owner:string) { return this.env.MCP_EVENTS_READY === 'true' && this.alarms.configured && Boolean(this.dependencies.callbackTransport) && await this.ingressReady(owner); }
  private origin() {
    try { return siteOrigin(this.env); }
    catch (error) { throw new AppError(503, error instanceof Error ? error.message : 'Site origin is not configured.'); }
  }
  private async provider(owner: string) {
    if (this.dependencies.provider) return this.dependencies.provider(owner);
    return resolveConnectedProvider(this.env, this.store, owner, this.http, this.dependencies.providerAdapters);
  }
  private mutation(request: Request) {
    if (request.headers.get('origin') !== this.origin()) throw new AppError(403, 'Request origin is not allowed.');
  }
  async handle(request: Request) {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/api/google/webhook' && request.method === 'POST') return await this.webhook(request,'google');
      const providerHook=path.match(/^\/api\/providers\/([a-z][a-z0-9_-]{0,63})\/webhook$/);
      if (providerHook && request.method === 'POST') return await this.webhook(request,providerHook[1]);
      if (path === '/api/alarms/wake' && request.method === 'POST') return await this.alarms.wake(request);
      const auth = await handleAuthRoute(request, this.env, this.now(), () => this.origin());
      if (auth) return auth;
      const owner = path === '/mcp' ? await authenticateMcp(request, this.env) : await authenticateApi(request, this.env, this.now());
      if (!owner) return Response.json({ error: 'Authentication is required.' }, { status: 401, headers: { 'Cache-Control': 'no-store', ...(path === '/mcp' ? { 'WWW-Authenticate': 'Bearer' } : {}) } });
      if (path === '/mcp') return request.method === 'POST' ? await this.mcp(request, owner) : new Response(null, {status:405,headers:{Allow:'POST'}});
      if (path === '/api/status' && request.method === 'GET') {
        const connection = await this.store.connection(owner);
        return json({ checkedAt: this.now(), connected: Boolean(connection), oauthReady: this.providerAuthorization(connection?.providerId ?? 'google')?.configured ?? false,
          ...await this.setupData(owner),
          webhookVerified: await this.ingressReady(owner), eventStartReady: await this.eventCatalogReady(owner), alarmReady: this.alarms.configured,
          dueWork: (await this.store.first<{count: number}>('SELECT count(*) AS count FROM occurrence_outbox WHERE owner = ? AND status = \'pending\'', owner))?.count ?? 0,
          enabled: await this.enabledCalendars(owner),
          subscriptions: await this.store.all('SELECT calendar_id, count(*) AS count FROM subscriptions WHERE owner = ? AND expires_at > ? GROUP BY calendar_id', owner, this.now()),
          watches: await this.store.all('SELECT calendar_id, status, expiration, synced_at, sync_failed FROM watches WHERE owner = ? AND status != \'revoked\'', owner) });
      }
      const authorizationRoute=path==='/api/google/connect'?{providerId:'google',action:'connect'}:path==='/api/google/callback'?{providerId:'google',action:'callback'}:(()=>{const match=path.match(/^\/api\/providers\/([a-z][a-z0-9_-]{0,63})\/(connect|callback)$/);return match?{providerId:match[1],action:match[2]}:null;})();
      if(authorizationRoute && ((authorizationRoute.action==='connect'&&request.method==='POST')||(authorizationRoute.action==='callback'&&request.method==='GET'))) {
        const authorization=this.providerAuthorization(authorizationRoute.providerId);
        if(!authorization) throw new AppError(503,'Calendar provider authorization is unavailable.');
        if(authorizationRoute.action==='connect') {this.mutation(request);return await authorization.start(owner);}
        return await authorization.complete(owner,request);
      }
      if (path === '/api/google/disconnect' && request.method === 'POST') {
        this.mutation(request);
        let provider: CalendarProvider | undefined;
        try { provider = await this.provider(owner); } catch { /* Local revocation must still succeed. */ }
        const watches = await this.store.all<WatchRow>("SELECT * FROM watches WHERE owner = ? AND status IN ('active', 'pending')", owner);
        await this.store.disconnect(owner);
        let stopped = true;
        for (const watch of watches) if (watch.resource_id) {
          try { if (!provider) throw new Error(); await provider.stopWatchingCalendar(watch.id, watch.resource_id); } catch { stopped = false; }
        }
        return json({ connected: false, providerStopComplete: stopped });
      }
      if (path === '/api/calendars' && request.method === 'GET') {
        const { available } = await this.discoverCalendars(owner);
        const enabled = new Map((await this.enabledCalendars(owner)).map(calendar => [calendar.calendar_id, calendar]));
        return json({ calendars: available.map(calendar => ({ ...calendar, enabled: enabled.has(calendar.id),
          writeBackEnabled: enabled.get(calendar.id)?.writeBackEnabled ?? false })), ...await this.setupData(owner) });
      }
      if (path === '/api/calendars/enable' && request.method === 'POST') {
        this.mutation(request); const id = await this.calendarId(request);
        const { available, connection } = await this.discoverCalendars(owner);
        const calendar = available.find(c => c.id === id && ['owner', 'writer', 'reader'].includes(c.accessRole));
        if (!calendar) throw new AppError(403, 'This calendar is unavailable for event access.');
        const saved = await this.store.first(`INSERT INTO calendars (owner, calendar_id, summary, enabled, generation, owner_calendar)
          SELECT ?, ?, ?, 1, ?, ? WHERE ? IS NULL OR EXISTS (SELECT 1 FROM connections WHERE owner = ? AND ${connectionIdentity} = ?)
          ON CONFLICT(owner, calendar_id) DO UPDATE SET summary = excluded.summary, enabled = 1, owner_calendar = excluded.owner_calendar
          RETURNING calendar_id`, owner, id, calendar.summary, random(), Number(calendar.primary === true && calendar.accessRole === 'owner'),
          connection?.id ?? null, owner, connection?.id ?? null);
        if (!saved) throw new AppError(403, 'Calendar connection changed during consent.');
        return json({ enabled: true, calendarId: id });
      }
      if (path === '/api/calendars/write-back' && request.method === 'POST') {
        this.mutation(request);
        const body = record(await request.json().catch(() => null));
        const calendarId = requiredId(body.calendarId, 'calendar ID');
        if (typeof body.enabled !== 'boolean') throw new AppError(400, 'An enabled boolean is required.');
        await this.store.setWriteBackEnabled(owner, calendarId, body.enabled);
        return json({ calendarId, writeBackEnabled: body.enabled });
      }
      if (request.method === 'POST' && /^\/api\/(agents|allowlist)\/(add|remove)$/.test(path)) {
        this.mutation(request);
        const body = record(await request.json().catch(() => null));
        const email = requiredEmail(body.email);
        if (path === '/api/agents/add') {
          if (body.label !== undefined && (typeof body.label !== 'string' || body.label.length > 128)) throw new AppError(400, 'Use a label of at most 128 characters.');
          await this.store.addAgentAlias(owner, email, body.label?.trim() ?? '', this.now());
        } else if (path === '/api/agents/remove') {
          await this.store.removeAgentAlias(owner, email);
        } else if (path === '/api/allowlist/add') {
          await this.store.addAllowlist(owner, email, this.now());
        } else {
          await this.store.removeAllowlist(owner, email);
        }
        return json(await this.setupData(owner));
      }
      if (request.method === 'POST' && (path === '/api/invitations/approve' || path === '/api/invitations/reject')) {
        this.mutation(request);
        const id = requiredId(record(await request.json().catch(() => null)).invitationId, 'invitation ID');
        const status = path.endsWith('/approve') ? 'approved' : 'rejected';
        await this.store.setInvitationApproval(owner, id, status, this.now());
        return json({ invitationId: id, approvalStatus: status });
      }
      if (path === '/api/calendars/disable' && request.method === 'POST') {
        this.mutation(request); const id = await this.calendarId(request);
        const watches = await this.store.all<WatchRow>("SELECT * FROM watches WHERE owner = ? AND calendar_id = ? AND status IN ('active', 'pending')", owner, id);
        await this.store.revoke(owner, id, random());
        // Revoke local authority first. Google stop is best effort; late webhooks fail closed.
        let stopped = true;
        for (const watch of watches) if (watch.resource_id) {
          try { await (await this.provider(owner)).stopWatchingCalendar(watch.id, watch.resource_id); } catch { stopped = false; }
        }
        return json({ enabled: false, providerStopComplete: stopped });
      }
      if (path === '/api/calendars/resync' && request.method === 'POST') {
        this.mutation(request);
        const calendarId = await this.calendarId(request);
        const calendar = await this.store.requireEnabled(owner, calendarId);
        const watch = await this.store.first<WatchRow>("SELECT * FROM watches WHERE owner = ? AND calendar_id = ? AND generation = ? AND status = 'active' AND expiration > ? ORDER BY expiration DESC LIMIT 1", owner, calendarId, calendar.generation, this.now());
        if (!watch) throw new AppError(409, 'No active watch. Start or renew the calendar watch first.');
        await this.sync(watch);
        return json({ calendarId, synchronized: true });
      }
      if (path === '/api/calendars/watch' && request.method === 'POST') {
        this.mutation(request); return await this.watch(owner, await this.calendarId(request));
      }
      if (path === '/api/calendars/unsubscribe' && request.method === 'POST') {
        this.mutation(request);
        await this.store.revokeSubscriptions(owner, await this.calendarId(request));
        return json({ subscriptions: 0 });
      }
      if (path === '/api/maintenance/run' && request.method === 'POST') {
        this.mutation(request);
        return json(await this.runMaintenance(owner));
      }
      throw new AppError(404, 'Route not found.');
    } catch (error) {
      if(error instanceof ProviderFailure) return Response.json({error:error.message,providerOutcome:error.kind},{status:error.status,headers:{'Cache-Control':'no-store',...(error.kind==='transient'&&error.retryAfter?{'Retry-After':error.retryAfter}:{})}});
      if (error instanceof AppError) return json({ error: error.message }, error.status);
      console.error('calendar_request_failed', { name: error instanceof Error ? error.name : 'unknown' });
      return json({ error: 'The integration is temporarily unavailable. Please retry.' }, 503);
    }
  }
  private async calendarId(request: Request) {
    return requiredId(record(await request.json().catch(() => null)).calendarId, 'calendar ID');
  }
  private async setupData(owner: string) {
    const [agentAliases, allowlist, rows] = await Promise.all([
      this.store.listAgentAliases(owner), this.store.listAllowlist(owner), this.store.listInvitations(owner),
    ]);
    const invitations = rows.map(({ id, calendar_id, agent_email, organizer_email, external_invite, approval_status, event_title, event_start, updated_at }) =>
      ({ id, calendar_id, agent_email, organizer_email, external_invite, approval_status, event_title, event_start, updated_at }));
    return { agentAliases, allowlist, invitations };
  }
  private async enabledCalendars(owner: string) {
    const rows = await this.store.all<{ calendar_id: string; summary: string; write_back_enabled: number }>(
      'SELECT calendar_id, summary, write_back_enabled FROM calendars WHERE owner = ? AND enabled = 1', owner);
    return rows.map(row => ({ calendar_id: row.calendar_id, summary: row.summary, writeBackEnabled: row.write_back_enabled === 1 }));
  }
  private async discoverCalendars(owner: string) {
    const connection = await this.store.connection(owner);
    const available = await (await this.provider(owner)).discoverCalendars();
    if (connection) {
      if ((await this.store.connection(owner))?.id !== connection.id) throw new AppError(403, 'Calendar connection changed during discovery.');
      const email = normalizeEmail(available.find(calendar => calendar.primary && calendar.accessRole === 'owner')?.id);
      if (!connection.ownerEmail && email) await this.store.saveOwnerEmail(connection, email);
    }
    return { available, connection };
  }
  public async renewWatchForMaintenance(owner: string, calendarId: string, expected?: RenewalExpectation) {
    await this.watch(owner, calendarId, expected);
  }
  public async syncWatchForMaintenance(watch: WatchRow) {
    await this.sync(watch);
  }
  public async runMaintenance(owner?: string) {
    return new CalendarMaintenance({
      store: this.store,
      now: this.now,
      ingressReady: current => this.ingressReady(current),
      renewWatch: (current, calendarId, expected) => this.renewWatchForMaintenance(current, calendarId, expected),
      syncWatch: watch => this.syncWatchForMaintenance(watch),
    }).run(owner);
  }
  private async watch(owner: string, calendarId: string, expected?: RenewalExpectation) {
    const calendar = await this.store.requireEnabled(owner, calendarId, expected?.generation);
    if (!await this.ingressReady(owner)) throw new AppError(503, 'Provider webhook ingress has not been verified for this server. Calendar consent is saved; watch creation is blocked.');
    const connection=await this.store.connection(owner),providerId=connection?.providerId??'google';
    if (expected && connection && (expected.connectionId ? connection.id !== expected.connectionId : !connection.legacy)) {
      throw new AppError(403, 'Calendar connection changed before watch renewal.');
    }
    const provider = await this.provider(owner);
    const id = random(), token = random() + random(), now = this.now();
    // Serialize concurrent renewals per calendar grant and fence background renewal to the expected watch & generation.
    const pending = await this.store.first(`INSERT INTO watches (id, owner, calendar_id, generation, token_hash, expiration, provider_id, connection_id, status)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending'
      WHERE EXISTS (SELECT 1 FROM calendars WHERE owner = ? AND calendar_id = ? AND enabled = 1 AND generation = ?)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM connections WHERE owner = ? AND provider_id = ? AND ${connectionIdentity} = ?))
        AND NOT EXISTS (SELECT 1 FROM watches WHERE owner = ? AND calendar_id = ? AND generation = ? AND status = 'pending' AND expiration > ?)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM watches WHERE id = ? AND owner = ? AND calendar_id = ? AND generation = ? AND status = 'active'))
      RETURNING id`, id, owner, calendarId, calendar.generation, await digest(token), now + 60_000, providerId, connection?.id ?? '',
      owner, calendarId, calendar.generation, connection?.id ?? null, owner, providerId, connection?.id ?? null,
      owner, calendarId, calendar.generation, now,
      expected?.watchId ?? null, expected?.watchId ?? null, owner, calendarId, calendar.generation);
    if (!pending) throw new AppError(409, 'Calendar watch renewal is already in progress or consent changed.');
    let created;
    try {
      created = await provider.watchCalendar(calendarId, id, token, this.origin() + (providerId==='google'?'/api/google/webhook':`/api/providers/${providerId}/webhook`));
      await this.store.requireEnabled(owner, calendarId, calendar.generation);
      if(connection && (await this.store.connection(owner))?.id!==connection.id) throw new AppError(403,'Calendar connection changed during watch creation.');
      await this.store.run("UPDATE watches SET resource_id = ?, expiration = ?, status = 'active' WHERE id = ? AND status = 'pending'", created.resourceId, created.expiration, id);
      const row = await this.store.first<WatchRow>('SELECT * FROM watches WHERE id = ?', id);
      if (row?.status !== 'active') throw new AppError(403, 'Calendar consent was revoked during watch creation.');
      await this.sync(row, provider);
      // Retire every superseded active channel for this calendar so duplicate active channels cannot persist.
      const superseded = await this.store.all<WatchRow>("SELECT * FROM watches WHERE owner = ? AND calendar_id = ? AND status = 'active' AND id != ?", owner, calendarId, id);
      for (const old of superseded) {
        await this.store.run("UPDATE watches SET status = 'revoked' WHERE id = ?", old.id);
        if (old.resource_id && old.provider_id===providerId && (!old.connection_id || old.connection_id===connection?.id)) { try { await provider.stopWatchingCalendar(old.id, old.resource_id); } catch { /* Expiry is retained; local channel is already revoked. */ } }
      }
      return json({ calendarId, watch: { status: 'active', expiration: created.expiration } });
    } catch (error) {
      await this.store.run("UPDATE watches SET status = 'failed' WHERE id = ? AND status IN ('active', 'pending')", id);
      if (created) { try { await provider.stopWatchingCalendar(id, created.resourceId); } catch { /* Local watch is inactive. */ } }
      throw error;
    }
  }
  private async sync(watch: WatchRow, provider?: CalendarProvider, messageNumber?: string) {
    const calendar = await this.store.requireEnabled(watch.owner, watch.calendar_id, watch.generation);
    const connection=await this.store.connection(watch.owner);
    if((!connection && !this.dependencies.provider) || (connection && (connection.providerId!==watch.provider_id || (watch.connection_id?connection.id!==watch.connection_id:!connection.legacy)))) throw new AppError(403,'Calendar watch connection changed.');
    const lockUntil = this.now() + 180_000;
    const lock = await this.store.first<{id: string}>("UPDATE watches SET sync_until = ? WHERE id = ? AND sync_until <= ? AND status = 'active' RETURNING id", lockUntil, watch.id, this.now());
    if (!lock) {
      // Preserve a recovery warning even when the in-flight fetch later succeeds.
      await this.store.run("UPDATE watches SET sync_failed = 2 WHERE id = ? AND status = 'active'", watch.id);
      throw new AppError(503, 'Calendar synchronization is already in progress. Use Resync now after it completes.');
    }
    const requireLock = async () => {
      await this.store.requireEnabled(watch.owner, watch.calendar_id, watch.generation);
      if (!await this.store.first("SELECT id FROM watches WHERE id = ? AND sync_until = ? AND sync_until > ? AND status = 'active'", watch.id, lockUntil, this.now())) {
        throw new AppError(503, 'Calendar synchronization lease expired. Use Resync now to recover.');
      }
    };
    try {
      // A notification can wait behind a newer sync after its initial read.
      // Ordering and cursor persistence both belong inside the sync lock.
      if (messageNumber) {
        const latest = await this.store.first<WatchRow>('SELECT * FROM watches WHERE id = ?', watch.id);
        const adapter = registeredAdapter(this.env, this.store, this.http, watch.provider_id, this.dependencies.providerAdapters);
        if (!latest || !adapter?.isNewer(messageNumber, latest.last_message)) return;
      }
      await this.store.run('UPDATE watches SET sync_failed = 0 WHERE id = ? AND sync_until = ?', watch.id, lockUntil);
      const calendarProvider = provider ?? await this.provider(watch.owner);
      const events = await calendarProvider.syncEvents(watch.calendar_id, this.now());
      if(connection && (await this.store.connection(watch.owner))?.id!==connection.id) throw new AppError(403,'Calendar connection changed during synchronization.');
      await requireLock();
      const allowed = new Set((await this.store.listAllowlist(watch.owner)).map(row => row.email));
      const upcoming = events.filter(event => event.calendarId === watch.calendar_id &&
        (!connection || event.provider === connection.providerId) && event.status !== 'cancelled' && Date.parse(event.start) >= this.now())
        .map(event => ({ event, source: organizer(event, connection?.ownerEmail ?? null, calendar.owner_calendar === 1, allowed) }));
      const accepted = upcoming.filter(({ source }) => source.kind !== 'blocked');
      if (accepted.length < upcoming.length) console.info('calendar_invite_blocked', { count: upcoming.length - accepted.length });
      await this.store.replaceEvents(watch, accepted.map(({ event, source }) => ({ event, externalOrganizer: source.kind === 'allowlisted' ? source.email : undefined })),
        this.now(), connection, lockUntil);
      await this.store.requireEnabled(watch.owner, watch.calendar_id, watch.generation);
      const current = await this.store.first<WatchRow>('SELECT * FROM watches WHERE id = ?', watch.id);
      if (current?.status !== 'active' || current.expiration <= this.now()) throw new AppError(409, 'Watch expired or was revoked during synchronization.');
      if(connection && (await this.store.connection(watch.owner))?.id!==connection.id) throw new AppError(403,'Calendar connection changed during synchronization.');
      await requireLock();
      if (connection) {
        const invitedCandidates = accepted.map(({ event }) => ({
          event, source: organizer(event, connection.ownerEmail ?? null, calendar.owner_calendar === 1, allowed, true),
        })).filter(({ source }) => source.kind !== 'blocked');
        await this.discoverInvitations(watch, connection, invitedCandidates, lockUntil);
      }
      await requireLock();
      const seeded = await this.alarms.seed(watch.owner, watch.calendar_id, watch.generation, calendarProvider, { channelTag: (await digest(watch.id)).slice(0, 12), ...(messageNumber ? { messageNumber } : {}) });
      if (connection && seeded.length) {
        const seen = new Set(events.map(event => event.providerEventId));
        const beyondSnapshot = seeded.filter(event => !seen.has(event.providerEventId) && event.calendarId === watch.calendar_id &&
          event.provider === connection.providerId && event.status !== 'cancelled' && Date.parse(event.start) >= this.now())
          .map(event => ({ event, source: organizer(event, connection.ownerEmail ?? null, calendar.owner_calendar === 1, allowed, true) }))
          .filter(({ source }) => source.kind !== 'blocked');
        if (beyondSnapshot.length) {
          await requireLock();
          await this.discoverInvitations(watch, connection, beyondSnapshot, lockUntil);
        }
      }
      if (messageNumber) await this.store.run('UPDATE watches SET last_message = ? WHERE id = ? AND sync_until = ? AND sync_until > ?', messageNumber, watch.id, lockUntil, this.now());
      await requireLock();
      console.info('calendar_snapshot_synced', { channelTag: (await digest(watch.id)).slice(0, 12), occurrences: events.length });
    } catch (error) {
      await this.store.run('UPDATE watches SET sync_failed = 1 WHERE id = ? AND sync_until = ?', watch.id, lockUntil);
      throw error;
    } finally {
      await this.store.run('UPDATE watches SET sync_until = 0 WHERE id = ? AND sync_until = ?', watch.id, lockUntil);
    }
  }
  private async discoverInvitations(watch: WatchRow, connection: CalendarConnection,
    events: { event: CalendarEvent; source: ReturnType<typeof organizer> }[], lease: number) {
    const aliases = await this.store.listAgentAliases(watch.owner);
    if (!aliases.length) return;
    await this.store.pruneInvitations(watch, connection, lease, this.now());
    const deliveries = new Deliveries(this.store, this.env, this.now, this.dependencies.callbackTransport);
    for (const { event, source } of events) {
      const attendees = attendeeEmails(event);
      for (const { email } of aliases) {
        if (!attendees.has(email)) continue;
        const invitation = await this.store.upsertInvitation(watch, connection, event, email, source, lease, this.now());
        if (!invitation) continue;
        const id = await digest(JSON.stringify(['calendar.event.invited', invitation.id]));
        const now = this.now();
        const receipt = invitation.notified_at === null
          ? await this.store.recordInvitationReceipt(id, invitation, event, watch, connection, lease, now, now + LATE_WINDOW)
          : await this.store.outbox(id);
        if (!receipt || receipt.status === 'terminal' || receipt.expires_at <= this.now()) continue;
        try {
          await deliveries.dispatch(id, event);
        } catch {
          try { await this.alarms.registerInvitationRetry(receipt); }
          catch { console.info('calendar_invitation_retry', { outcome: 'registration_failed' }); }
        }
      }
    }
  }
  private async applyWriteBack(owner: string, name: 'calendar_rsvp' | 'calendar_run_note', input: unknown) {
    const args = record(input);
    const calendarId = requiredId(args.calendarId, 'calendar ID');
    const eventId = requiredId(args.eventId, 'event ID');
    const agentEmail = requiredEmail(args.agentEmail);
    const fields = name === 'calendar_rsvp' ? ['responseStatus'] : ['runStatus', 'note'];
    if (Object.keys(args).some(key => !Object.hasOwn(writeBackFields, key) && !fields.includes(key))) throw new AppError(400, 'Unknown write-back argument.');
    let action: WriteBackAction;
    if (name === 'calendar_rsvp') {
      const { responseStatus } = args;
      if (responseStatus !== 'accepted' && responseStatus !== 'tentative' && responseStatus !== 'declined') throw new AppError(400, 'Invalid response status.');
      action = { kind: 'rsvp', agentEmail, responseStatus };
    } else {
      const { runStatus, note } = args;
      if (runStatus !== 'started' && runStatus !== 'completed' && runStatus !== 'failed') throw new AppError(400, 'Invalid run status.');
      if (note !== undefined && (typeof note !== 'string' || note.length > 280)) throw new AppError(400, 'Use a note of at most 280 characters.');
      action = { kind: 'run_note', agentEmail, runStatus, note: note?.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '') };
    }
    const grant = await this.store.requireEnabled(owner, calendarId);
    if (grant.write_back_enabled !== 1) throw new AppError(403, 'Calendar write-back is disabled.');
    const connection = await this.store.connection(owner);
    if (!connection || !await this.store.hasAgentAlias(owner, agentEmail)) throw new AppError(403, 'This agent alias is not registered on a connected calendar.');
    const provider = await this.provider(owner);
    if (!provider.getOccurrence || !provider.applyWriteBack) throw new AppError(422, 'This provider does not support calendar write-back.');
    const authorize = async (live: CalendarEvent) => {
      if (live.calendarId !== calendarId || live.providerEventId !== eventId ||
        !await this.store.authorizeEvent(connection, grant.generation, live, agentEmail, 'calendar.event.starting', true)) {
        throw new AppError(403, 'This write-back is not authorized for the current occurrence.');
      }
    };
    const live = await provider.getOccurrence(calendarId, eventId);
    if (!live) throw new AppError(403, 'This occurrence is unavailable.');
    await authorize(live);
    return provider.applyWriteBack(calendarId, eventId, action, authorize);
  }
  private async webhook(request: Request,providerId:string) {
    const adapter=registeredAdapter(this.env,this.store,this.http,providerId,this.dependencies.providerAdapters);
    if(!adapter) throw new AppError(404,'Calendar provider is unavailable.');
    const change=await adapter.readChange(request);
    const {watchId:id,token,resourceId:resource,cursor:number,state}=change;
    if(![id,token,resource,number].every(value=>typeof value==='string'&&value.length>0&&value.length<=1024)||!['initial','changed','removed'].includes(state)) throw new AppError(400,'Invalid provider change notification.');
    const watch = await this.store.first<WatchRow>('SELECT * FROM watches WHERE id = ?', id);
    if (!watch || watch.token_hash !== await digest(token) || watch.expiration <= this.now() || !['active', 'pending'].includes(watch.status)) throw new AppError(403, 'Notification channel is not authorized.');
    await this.store.requireEnabled(watch.owner, watch.calendar_id, watch.generation);
    // Google can send initial sync before events.watch returns its resource ID.
    const connection=await this.store.connection(watch.owner);
    if(watch.provider_id!==providerId || (connection && (connection.providerId!==providerId || (watch.connection_id?connection.id!==watch.connection_id:!connection.legacy)))) throw new AppError(403,'Notification provider or connection does not match the watch.');
    if(!connection && !this.dependencies.provider) throw new AppError(403,'Calendar connection was revoked.');
    if (watch.status === 'pending' && state === 'initial') {
      console.info('calendar_notification', { channelTag: (await digest(id)).slice(0, 12), state, messageNumber: number, outcome: 'pending-initial' });
      return new Response(null, { status: 204 });
    }
    if (watch.resource_id !== resource || watch.status !== 'active') throw new AppError(403, 'Notification resource does not match.');
    // Initial notifications carry no event changes; watch creation owns the bootstrap fetch.
    if (state === 'initial') {
      console.info('calendar_notification', { channelTag: (await digest(id)).slice(0, 12), state, messageNumber: number, outcome: 'active-initial' });
      return new Response(null, { status: 204 });
    }
    if (!adapter.isNewer(number,watch.last_message)) return new Response(null, { status: 204 });
    try { await this.sync(watch, undefined, number); } catch (error) {
      if (error instanceof AppError && error.status === 403) await this.store.revoke(watch.owner, watch.calendar_id, random(), watch.generation);
      throw error;
    }
    console.info('calendar_notification', { channelTag: (await digest(id)).slice(0, 12), state, messageNumber: number, outcome: 'synchronized' });
    return new Response(null, { status: 204 });
  }
  private async mcp(request: Request, owner: string) {
    let parsed;
    try { parsed = await readMcpMessage(request, this.env.SITE_ORIGIN ? this.origin() : undefined); }
    catch (e) { if (e instanceof McpProtocolError) return mcpErrorResponse(e); throw e; }
    const { rpc, modern } = parsed;
    const reply = (result: object) => json({ jsonrpc: '2.0', id: rpc.id ?? null, result: modern ? { resultType: 'complete', ...result } : result });
    const error = (code: number, message: string, status = 200) => json({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code, message } }, status);
    const capabilities = { tools: {} };
    if (rpc.method === 'server/discover') return reply({ resultType: 'complete', supportedVersions: SUPPORTED_MCP_VERSIONS, capabilities: { ...capabilities, events: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'schedule-my-agents', title: 'Schedule my agents', version: '0.1.0' } } });
    if (rpc.method === 'initialize' && !modern) return reply({ protocolVersion: typeof rpc.params?.protocolVersion === 'string' && SUPPORTED_MCP_VERSIONS.slice(1).includes(rpc.params.protocolVersion) ? rpc.params.protocolVersion : '2025-03-26', capabilities, serverInfo: { name: 'schedule-my-agents', version: '0.1.0' } });
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (rpc.method === 'ping') return reply({});
    if (rpc.method === 'tools/list') return reply({ tools });
    if (rpc.method === 'tools/call') {
      const name = rpc.params?.name, args = rpc.params?.arguments;
      const failure = (message: string) => reply({ isError: true, content: [{ type: 'text', text: message }] });
      const success = (data: unknown) => reply({ content: [{ type: 'text', text: JSON.stringify(data) }] });
      if (name === 'calendar_rsvp' || name === 'calendar_run_note') {
        try { return success(await this.applyWriteBack(owner, name, args)); }
        catch (error) { if (error instanceof AppError) return failure(error.message); throw error; }
      }
      if (name !== 'enabled_calendars' && name !== 'agent_aliases') return error(-32602, 'Unknown tool.');
      if (!emptyToolArguments(args)) return failure('This tool accepts only an empty arguments object.');
      if (name === 'agent_aliases') return success((await this.store.listAgentAliases(owner)).map(({ email, label }) => ({ email, label })));
      return success((await this.enabledCalendars(owner)).map(({ calendar_id, ...calendar }) => ({ calendarId: calendar_id, ...calendar })));
    }
    if (rpc.method === 'events/list') {
      const ready = await this.eventCatalogReady(owner);
      const grant = ready && await this.store.connection(owner) && await this.store.first('SELECT calendar_id FROM calendars WHERE owner = ? AND enabled = 1 LIMIT 1', owner);
      return reply({ events: grant ? eventDefinitions : [] });
    }
    if (rpc.method === 'events/subscribe' || rpc.method === 'events/unsubscribe') {
      const subscriptions = new Subscriptions(this.store, this.env, this.now, this.dependencies.callbackTransport);
      try {
        if (rpc.method === 'events/unsubscribe') {
          const result = await subscriptions.unsubscribe(owner, rpc.params);
          console.info('calendar_subscription', { method: rpc.method, outcome: 'accepted' });
          return reply(result);
        }
        const result = await subscriptions.subscribe(owner, rpc.params);
        const subscription = await subscriptions.active(result.id, owner);
        if (subscription?.lead_time_minutes && this.alarms.configured) {
          const watch = await this.store.first<WatchRow>(`SELECT * FROM watches WHERE owner = ? AND calendar_id = ? AND generation = ?
            AND status = 'active' AND expiration > ? ORDER BY expiration DESC LIMIT 1`,
            owner, subscription.calendar_id, subscription.generation, this.now());
          if (watch) {
            const connection = await this.store.connection(owner);
            if (connection?.providerId === watch.provider_id && (watch.connection_id ? connection.id === watch.connection_id : connection.legacy)) {
              try { await this.alarms.seed(owner, watch.calendar_id, watch.generation, await this.provider(owner)); }
              catch {
                await this.store.run("UPDATE watches SET sync_failed = 1 WHERE id = ? AND status = 'active' AND sync_failed = 0", watch.id);
                throw new SubscriptionError(-32015, 'Subscription saved. Lead-time alarm registration failed. Retry or resync the calendar.', 'alarm_registration_failed');
              }
            }
          }
        }
        console.info('calendar_subscription', { method: rpc.method, outcome: 'accepted' });
        return reply(result);
      }
      catch (e) {
        if (e instanceof SubscriptionError) {
          console.info('calendar_subscription', { method: rpc.method, outcome: 'rejected', code: e.code, reason: e.reason ?? 'invalid_or_unauthorized' });
          return json({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code: e.code, message: e.message, ...(e.reason ? { data: { reason: e.reason } } : {}) } });
        }
        throw e;
      }
    }
    return error(-32601, 'Method not found.', modern ? 404 : 200);
  }
}
