import { Deliveries } from './delivery.ts';
import type { CallbackTransport } from './subscriptions.ts';
import { boundedBody, bytes, LATE_WINDOW, MAX_HORIZON, mac, parseJob, signedHeaders, verified, type AlarmJob } from '../../shared/alarm.ts';
import { base64, digest, open, seal } from './crypto.ts';
import { type Fetch } from './google.ts';
import { Store } from './store.ts';
import { AppError, ProviderFailure, type CalendarEvent, type CalendarProvider, type Environment } from './types.ts';

// Retain v1's encrypted field names and Google ID material for already registered jobs.
type Envelope = { v: 1; owner: string; calendarId: string; generation: string; eventId: string; start: number; expiresAt: number; seriesId?: string; originalStartTime?: string; provider?: string; connectionId?: string };
type AuditSource = { channelTag?: string; messageNumber?: string; parentAlarmTag?: string };
const AUDIENCE = 'calendar-alarm:v1';
// Old Google v1 envelopes retain their original timestamp in the MAC input.
// Normalize only the comparison with the adapter's canonical recurrence ID.
function recurrenceIdentity(provider:string|undefined,id:string|undefined) {
  return !provider && id && Number.isFinite(Date.parse(id))
    ? new Date(id).toISOString().replace('.000Z','Z') : id;
}
export class OccurrenceAlarms {
  constructor(private env: Environment, private store: Store, private http: Fetch, private now: () => number, private provider: (owner: string) => Promise<CalendarProvider>, private transport?: CallbackTransport) {}
  get configured() { return Boolean(this.env.DISPATCHER_ORIGIN && this.env.ALARM_ENCRYPTION_KEY && this.env.ALARM_REGISTRATION_KEY && this.env.ALARM_CALLBACK_KEY); }
  private async id(e: Envelope) {
    const material = await crypto.subtle.importKey('raw', bytes(this.env.ALARM_ENCRYPTION_KEY!), 'HKDF', false, ['deriveBits']);
    const derived = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(AUDIENCE + ':logical-id') }, material, 256);
    const identity = [AUDIENCE, e.owner, e.calendarId, e.generation, e.seriesId ?? e.eventId, e.originalStartTime ?? e.eventId, e.start];
    if (e.provider) identity.push(e.provider);
    if (e.connectionId) identity.push(e.connectionId);
    return mac(base64(new Uint8Array(derived)), JSON.stringify(identity));
  }
  async register(owner: string, calendarId: string, generation: string, event: CalendarEvent, source: AuditSource = {}, connectionId?: string) {
    const start = Date.parse(event.start);
    if (!Number.isSafeInteger(start) || start <= this.now() || start > this.now() + MAX_HORIZON) return;
    await this.store.requireEnabled(owner, calendarId, generation);
    const connection = await this.store.connection(owner);
    if (!connection) throw new AppError(403, 'Calendar connection was revoked.');
    if (connectionId && connection.id !== connectionId) throw new AppError(403, 'Calendar connection changed during scheduling.');
    if (event.provider !== connection.providerId) throw new AppError(403, 'Occurrence provider does not match the connected provider.');
    const e: Envelope = { v: 1, owner, calendarId, generation, eventId: event.providerEventId, start, expiresAt: start + LATE_WINDOW,
      ...(event.seriesId ? { seriesId: event.seriesId, originalStartTime: event.recurrenceId } : {}),
      ...(event.provider !== 'google' ? { provider: event.provider } : {}),
      ...(!connection.legacy ? { connectionId: connection.id } : {}) };
    const job: AlarmJob = { id: await this.id(e), dueAt: start, expiresAt: e.expiresAt, envelope: await seal(JSON.stringify(e), this.env.ALARM_ENCRYPTION_KEY, AUDIENCE) };
    const url = new URL(this.env.DISPATCHER_ORIGIN!);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new AppError(503, 'Invalid dispatcher origin.');
    const body = JSON.stringify(job);
    const response = await this.http(new URL('/alarms', url), { method: 'POST', body,
      headers: await signedHeaders(this.env.ALARM_REGISTRATION_KEY!, '/alarms', body, this.now()), redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new AppError(503, 'Alarm registration failed. Use Resync now to recover.');
    const result = await response.json() as { registered?: boolean; id?: string };
    if (!result.registered || result.id !== job.id) throw new AppError(503, 'Alarm registration was not acknowledged.');
    // Consent may have changed while the opaque alarm was being registered; wake validation also rejects it.
    await this.store.requireEnabled(owner, calendarId, generation);
    if ((await this.store.connection(owner))?.id !== connection.id) throw new AppError(403, 'Calendar connection changed during scheduling.');
    console.info('occurrence_registered', { ...source, occurrenceTag: (await digest(JSON.stringify([owner, calendarId, event.providerEventId]))).slice(0, 12), alarmTag: job.id.slice(0, 12), dueAt: start });
  }
  async seed(owner: string, calendarId: string, generation: string, provider: CalendarProvider, source: AuditSource = {}) {
    if (!this.configured) return;
    if (!provider.alarmCandidates) throw new AppError(503, 'Provider alarm discovery is unavailable.');
    const connection = await this.store.connection(owner);
    if (!connection) throw new AppError(403,'Calendar connection was revoked.');
    for (const event of await provider.alarmCandidates(calendarId, this.now())) await this.register(owner, calendarId, generation, event, source, connection.id);
  }
  private log(id: string, outcome: string, dueAt: number) {
    console.info('occurrence_wake', { alarmTag: id.slice(0, 12), outcome, latenessMs: this.now() - dueAt });
  }
  private async stop(id: string) {
    await this.store.batch([
      this.store.statement("UPDATE deliveries SET status = 'terminal', body = '' WHERE outbox_id = ? AND status = 'pending'", id),
      this.store.statement("UPDATE occurrence_outbox SET status = 'terminal', payload = '' WHERE id = ?", id),
    ]);
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
        e.start !== job.dueAt || e.expiresAt !== job.expiresAt || await this.id(e) !== job.id) throw new Error();
    } catch { throw new AppError(403, 'Alarm envelope is not valid.'); }
    const ack = () => new Response(null, { status: 204 });
    if (this.now() < e.start) throw new AppError(409, 'Alarm is not due.');
    if (this.now() > e.expiresAt) {
      await this.store.run('DELETE FROM deliveries WHERE outbox_id = ?', job.id);
      await this.store.run('DELETE FROM occurrence_outbox WHERE id = ? AND expires_at < ?', job.id, this.now());
      this.log(job.id, 'expired_cleanup', e.start); return ack();
    }
    const grant = await this.store.calendar(e.owner, e.calendarId);
    const connection = await this.store.connection(e.owner);
    if (!grant?.enabled || grant.generation !== e.generation || !connection || connection.providerId !== (e.provider ?? 'google') ||
      (e.connectionId ? connection.id !== e.connectionId : !connection.legacy)) {
      await this.stop(job.id);
      this.log(job.id, 'consent_revoked', e.start); return ack();
    }
    let provider:CalendarProvider;
    let event: CalendarEvent | null;
    try { provider=await this.provider(e.owner);if (!provider.getOccurrence) throw new AppError(503, 'Provider occurrence lookup is unavailable.');event = await provider.getOccurrence(e.calendarId, e.eventId); }
    catch (error) {
      if(error instanceof ProviderFailure && error.kind==='permanent') {await this.stop(job.id);this.log(job.id,'provider_request_rejected',e.start);return ack();}
      if (error instanceof AppError && error.status === 403) { await this.stop(job.id); this.log(job.id, 'provider_access_revoked', e.start); return ack(); }
      throw error;
    }
    const currentConnection = await this.store.connection(e.owner), currentGrant = await this.store.calendar(e.owner,e.calendarId);
    if (currentConnection?.id !== connection.id || !currentGrant?.enabled || currentGrant.generation !== e.generation) {
      await this.stop(job.id); this.log(job.id,'consent_revoked',e.start); return ack();
    }
    if (!event || event.status === 'cancelled' || event.calendarId !== e.calendarId || event.providerEventId !== e.eventId || Date.parse(event.start) !== e.start ||
      event.provider !== (e.provider ?? 'google') || event.seriesId !== e.seriesId || recurrenceIdentity(e.provider,event.recurrenceId) !== recurrenceIdentity(e.provider,e.originalStartTime)) {
      await this.stop(job.id);
      this.log(job.id, 'stale_or_cancelled', e.start); return ack();
    }
    // Only a valid wake advances the chain. Register first; retries/dedup must not break the successor.
    if (e.seriesId) {
      if (!provider.nextOccurrence) throw new AppError(503, 'Provider recurrence lookup is unavailable.');
      const next = await provider.nextOccurrence(e.calendarId, e.seriesId, Math.max(e.start, this.now()));
      if (next) {
        try { await this.register(e.owner, e.calendarId, e.generation, next, { parentAlarmTag: job.id.slice(0, 12) }, connection.id); }
        catch (error) { if (error instanceof AppError && error.status === 403) { await this.stop(job.id); this.log(job.id,'consent_revoked',e.start); return ack(); } throw error; }
      }
    }
    // A single guarded INSERT claims due work. Status reads and snapshot replacement cannot delete it.
    const receipt = await this.store.claimDue(job.id, e.owner, e.calendarId, e.generation, event, e.start, this.now(), e.expiresAt, connection);
    this.log(job.id, receipt?.claimed ? 'due_work' : 'duplicate_or_revoked', e.start);
    if(receipt) await new Deliveries(this.store, this.env, this.now, this.transport).dispatch(receipt.id, event);
    return ack();
  }
}
