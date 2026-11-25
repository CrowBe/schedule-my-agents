import { Deliveries, PendingDelivery } from './delivery.ts';
import { validLeadTime, type CallbackTransport } from './subscriptions.ts';
import { boundedBody, bytes, LATE_WINDOW, MAX_HORIZON, mac, parseJob, signedHeaders, verified, type AlarmJob } from '../../shared/alarm.ts';
import { base64, digest, open, seal } from './crypto.ts';
import { type Fetch } from './google.ts';
import { Store, type OutboxRow } from './store.ts';
import { attendeeEmails } from './provenance.ts';
import { AppError, ProviderFailure, type CalendarEvent, type CalendarProvider, type Environment } from './types.ts';

// Retain v1's encrypted field names and Google ID material for already registered jobs.
type Envelope = { v: 1; owner: string; calendarId: string; generation: string; eventId: string; start: number; expiresAt: number; seriesId?: string; originalStartTime?: string; provider?: string; connectionId?: string; leadTimeMinutes?: number; invitationReceiptId?: string };
type AuditSource = { channelTag?: string; messageNumber?: string; parentAlarmTag?: string };
const AUDIENCE = 'calendar-alarm:v1';
// Old Google v1 envelopes retain their original timestamp in the MAC input.
// Normalize only the comparison with the adapter's canonical recurrence ID.
function recurrenceIdentity(provider:string|undefined,id:string|undefined) {
  return !provider && id && Number.isFinite(Date.parse(id))
    ? new Date(id).toISOString().replace('.000Z','Z') : id;
}
export class OccurrenceAlarms {
  private env: Environment;
  private store: Store;
  private http: Fetch;
  private now: () => number;
  private provider: (owner: string) => Promise<CalendarProvider>;
  private transport?: CallbackTransport;
  constructor(env: Environment, store: Store, http: Fetch, now: () => number, provider: (owner: string) => Promise<CalendarProvider>, transport?: CallbackTransport) {
    this.env = env; this.store = store; this.http = http; this.now = now; this.provider = provider; this.transport = transport;
  }
  get configured() { return Boolean(this.env.DISPATCHER_ORIGIN && this.env.ALARM_ENCRYPTION_KEY && this.env.ALARM_REGISTRATION_KEY && this.env.ALARM_CALLBACK_KEY); }
  private async id(e: Envelope) {
    const material = await crypto.subtle.importKey('raw', bytes(this.env.ALARM_ENCRYPTION_KEY!), 'HKDF', false, ['deriveBits']);
    const derived = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(AUDIENCE + ':logical-id') }, material, 256);
    const identity = [AUDIENCE, e.owner, e.calendarId, e.generation, e.seriesId ?? e.eventId, e.originalStartTime ?? e.eventId, e.start];
    if (e.provider) identity.push(e.provider);
    if (e.connectionId) identity.push(e.connectionId);
    if (e.leadTimeMinutes) identity.push(e.leadTimeMinutes);
    if (e.invitationReceiptId) identity.push('calendar.event.invited', e.invitationReceiptId);
    return mac(base64(new Uint8Array(derived)), JSON.stringify(identity));
  }
  async register(owner: string, calendarId: string, generation: string, event: CalendarEvent, source: AuditSource = {}, connectionId?: string, leadTimeMinutes = 0) {
    const start = Date.parse(event.start);
    const dueAt = start - leadTimeMinutes * 60_000;
    if (!validLeadTime(leadTimeMinutes) || !Number.isSafeInteger(start) || dueAt <= this.now() || start > this.now() + MAX_HORIZON) return;
    await this.store.requireEnabled(owner, calendarId, generation);
    const connection = await this.store.connection(owner);
    if (!connection) throw new AppError(403, 'Calendar connection was revoked.');
    if (connectionId && connection.id !== connectionId) throw new AppError(403, 'Calendar connection changed during scheduling.');
    if (event.provider !== connection.providerId) throw new AppError(403, 'Occurrence provider does not match the connected provider.');
    const e: Envelope = { v: 1, owner, calendarId, generation, eventId: event.providerEventId, start, expiresAt: dueAt + LATE_WINDOW,
      ...(event.seriesId ? { seriesId: event.seriesId, originalStartTime: event.recurrenceId } : {}),
      ...(event.provider !== 'google' ? { provider: event.provider } : {}),
      ...(!connection.legacy ? { connectionId: connection.id } : {}),
      ...(leadTimeMinutes ? { leadTimeMinutes } : {}) };
    const job = await this.postAlarm(e, dueAt);
    // Consent may have changed while the opaque alarm was being registered; wake validation also rejects it.
    await this.store.requireEnabled(owner, calendarId, generation);
    if ((await this.store.connection(owner))?.id !== connection.id) throw new AppError(403, 'Calendar connection changed during scheduling.');
    console.info('occurrence_registered', { ...source, occurrenceTag: (await digest(JSON.stringify([owner, calendarId, event.providerEventId]))).slice(0, 12), alarmTag: job.id.slice(0, 12), dueAt });
  }
  private async postAlarm(e: Envelope, dueAt: number) {
    const job: AlarmJob = { id: await this.id(e), dueAt, expiresAt: e.expiresAt, envelope: await seal(JSON.stringify(e), this.env.ALARM_ENCRYPTION_KEY, AUDIENCE) };
    const url = new URL(this.env.DISPATCHER_ORIGIN!);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new AppError(503, 'Invalid dispatcher origin.');
    const body = JSON.stringify(job);
    const response = await this.http(new URL('/alarms', url), { method: 'POST', body,
      headers: await signedHeaders(this.env.ALARM_REGISTRATION_KEY!, '/alarms', body, this.now()), redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new AppError(503, 'Alarm registration failed. Use Resync now to recover.');
    const result = await response.json() as { registered?: boolean; id?: string };
    if (!result.registered || result.id !== job.id) throw new AppError(503, 'Alarm registration was not acknowledged.');
    return job;
  }
  async registerInvitationRetry(receipt: OutboxRow) {
    if (!this.configured || receipt.expires_at <= this.now()) return;
    const connection = await this.store.connection(receipt.owner);
    if (!connection || connection.id !== receipt.connection_id) return;
    await this.store.requireEnabled(receipt.owner, receipt.calendar_id, receipt.generation);
    await this.postAlarm({
      v: 1, owner: receipt.owner, calendarId: receipt.calendar_id, generation: receipt.generation,
      eventId: receipt.provider_event_id, start: receipt.due_at, expiresAt: receipt.expires_at,
      ...(!connection.legacy ? { connectionId: connection.id } : {}),
      ...(receipt.provider_id !== 'google' ? { provider: receipt.provider_id } : {}), invitationReceiptId: receipt.id,
    }, receipt.due_at);
  }
  async seed(owner: string, calendarId: string, generation: string, provider: CalendarProvider, source: AuditSource = {}): Promise<CalendarEvent[]> {
    if (!this.configured) return [];
    if (!provider.alarmCandidates) throw new AppError(503, 'Provider alarm discovery is unavailable.');
    const connection = await this.store.connection(owner);
    if (!connection) throw new AppError(403,'Calendar connection was revoked.');
    const leadTimes = await this.store.activeLeadTimes(owner, calendarId, generation, this.now());
    const candidates = await provider.alarmCandidates(calendarId, this.now());
    for (const leadTime of leadTimes) {
      for (const event of candidates) {
        const after = this.now() + leadTime * 60_000;
        let candidate: CalendarEvent | null = event;
        if (leadTime && event.seriesId && Date.parse(event.start) <= after) {
          if (!provider.nextOccurrence) throw new AppError(503, 'Provider recurrence lookup is unavailable.');
          candidate = await provider.nextOccurrence(calendarId, event.seriesId, after);
        }
        if (candidate) await this.register(owner, calendarId, generation, candidate, source, connection.id, leadTime);
      }
    }
    return candidates;
  }
  private log(id: string, outcome: string, dueAt: number) {
    console.info('occurrence_wake', { alarmTag: id.slice(0, 12), outcome, latenessMs: this.now() - dueAt });
  }
  async wake(request: Request) {
    if (!this.configured) throw new AppError(503, 'Occurrence alarms are not configured.');
    let body: string;
    try { body = await boundedBody(request); } catch { throw new AppError(413, 'Alarm request too large.'); }
    if (!await verified(request, body, this.env.ALARM_CALLBACK_KEY, this.now())) throw new AppError(403, 'Alarm callback is not authorized.');
    let job: AlarmJob | null; let e: Envelope;
    try {
      job = parseJob(JSON.parse(body));
      if (!job) throw new Error();
      e = JSON.parse(await open(job.envelope, this.env.ALARM_ENCRYPTION_KEY, AUDIENCE));
      if (e.v !== 1 || ![e.owner, e.calendarId, e.generation, e.eventId].every(s => typeof s === 'string' && s.length > 0 && s.length <= 1024) ||
        (e.provider !== undefined && (typeof e.provider !== 'string' || !e.provider || e.provider.length > 128)) ||
        (e.leadTimeMinutes !== undefined && (!validLeadTime(e.leadTimeMinutes) || e.leadTimeMinutes === 0)) ||
        (e.invitationReceiptId !== undefined && (!/^[\w-]{43}$/.test(e.invitationReceiptId) || e.leadTimeMinutes !== undefined)) ||
        !Number.isSafeInteger(e.start) || e.start - (e.leadTimeMinutes ?? 0) * 60_000 !== job.dueAt ||
        e.expiresAt !== job.dueAt + LATE_WINDOW || e.expiresAt !== job.expiresAt || await this.id(e) !== job.id) throw new Error();
    } catch { throw new AppError(403, 'Alarm envelope is not valid.'); }
    const { dueAt } = job;
    const leadTime = e.leadTimeMinutes ?? 0;
    const deliveries = new Deliveries(this.store, this.env, this.now, this.transport);
    const receipts = () => e.invitationReceiptId ? [{ id: e.invitationReceiptId }]
      : this.store.dueReceipts(e.owner, e.calendarId, e.generation, e.eventId, dueAt, leadTime);
    const ack = () => new Response(null, { status: 204 });
    const stop = async (outcome: string) => {
      for (const { id } of await receipts()) await deliveries.terminal(id);
      this.log(job.id, outcome, dueAt);
      return ack();
    };
    if (this.now() < dueAt) throw new AppError(409, 'Alarm is not due.');
    if (this.now() > e.expiresAt) {
      for (const { id } of await receipts()) {
        await this.store.batch([
          this.store.statement('DELETE FROM deliveries WHERE outbox_id = ?', id),
          this.store.statement('DELETE FROM occurrence_outbox WHERE id = ? AND expires_at < ?', id, this.now()),
        ]);
      }
      this.log(job.id, 'expired_cleanup', dueAt);
      return ack();
    }
    const grant = await this.store.calendar(e.owner, e.calendarId);
    const connection = await this.store.connection(e.owner);
    if (!grant?.enabled || grant.generation !== e.generation || !connection || connection.providerId !== (e.provider ?? 'google') ||
      (e.connectionId ? connection.id !== e.connectionId : !connection.legacy)) return stop('consent_revoked');
    if (e.invitationReceiptId) {
      const receipt = await this.store.outbox(e.invitationReceiptId);
      if (!receipt || receipt.status === 'terminal') return ack();
    }
    let provider: CalendarProvider;
    let event: CalendarEvent | null;
    let lookup: () => Promise<CalendarEvent | null>;
    try {
      provider = await this.provider(e.owner);
      const getOccurrence = provider.getOccurrence?.bind(provider);
      if (!getOccurrence) throw new AppError(503, 'Provider occurrence lookup is unavailable.');
      lookup = () => getOccurrence(e.calendarId, e.eventId);
      event = await lookup();
    } catch (error) {
      if (error instanceof ProviderFailure && error.kind === 'permanent') return stop('provider_request_rejected');
      if (error instanceof AppError && error.status === 403) return stop('provider_access_revoked');
      throw error;
    }
    const currentConnection = await this.store.connection(e.owner), currentGrant = await this.store.calendar(e.owner, e.calendarId);
    if (currentConnection?.id !== connection.id || !currentGrant?.enabled || currentGrant.generation !== e.generation) return stop('consent_revoked');
    if (!event || event.status === 'cancelled' || event.calendarId !== e.calendarId || event.providerEventId !== e.eventId ||
      event.provider !== (e.provider ?? 'google')) return stop('stale_or_cancelled');
    if (e.invitationReceiptId) {
      await deliveries.dispatch(e.invitationReceiptId, event, lookup);
      return ack();
    }
    if (Date.parse(event.start) - leadTime * 60_000 !== dueAt || event.seriesId !== e.seriesId ||
      recurrenceIdentity(e.provider, event.recurrenceId) !== recurrenceIdentity(e.provider, e.originalStartTime)) return stop('stale_or_cancelled');
    if (leadTime && !(await this.store.activeLeadTimes(e.owner, e.calendarId, e.generation, this.now())).includes(leadTime)) {
      return stop('subscription_revoked');
    }
    // Only a valid wake advances the chain. Register first so retrying a receipt cannot break the successor.
    if (e.seriesId) {
      if (!provider.nextOccurrence) throw new AppError(503, 'Provider recurrence lookup is unavailable.');
      const next = await provider.nextOccurrence(e.calendarId, e.seriesId, Math.max(e.start, this.now() + leadTime * 60_000));
      if (next) {
        try { await this.register(e.owner, e.calendarId, e.generation, next, { parentAlarmTag: job.id.slice(0, 12) }, connection.id, leadTime); }
        catch (error) { if (error instanceof AppError && error.status === 403) return stop('consent_revoked'); throw error; }
      }
    }
    const existing = new Set((await receipts()).map(row => row.id));
    const attendees = attendeeEmails(event);
    const aliases = (await this.store.listAgentAliases(e.owner)).filter(alias => attendees.has(alias.email));
    let claimed = false;
    for (const email of ['', ...aliases.map(alias => alias.email)]) {
      const route = await this.store.authorizeEvent(connection, e.generation, event, email, 'calendar.event.starting');
      if (!route) continue;
      const id = email ? await digest(JSON.stringify([job.id, email])) : job.id;
      const receipt = await this.store.claimDue(id, e.owner, e.calendarId, e.generation, event, dueAt, this.now(), e.expiresAt,
        connection, 'calendar.event.starting', email, leadTime, route.invitationId);
      if (receipt) { existing.add(receipt.id); claimed ||= receipt.claimed; }
    }
    this.log(job.id, claimed ? 'due_work' : 'duplicate_or_revoked', dueAt);
    let pending = false;
    for (const id of existing) {
      try { await deliveries.dispatch(id, event, lookup); }
      catch (error) { if (!(error instanceof PendingDelivery)) throw error; pending = true; }
    }
    if (pending) throw new PendingDelivery();
    return ack();
  }
}
