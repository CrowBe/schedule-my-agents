import { boundedBody, bytes, LATE_WINDOW, MAX_HORIZON, mac, parseJob, signedHeaders, verified, type AlarmJob } from '../../shared/alarm.ts';
import { base64, open, seal } from './crypto.ts';
import { type Fetch } from './google.ts';
import { Store } from './store.ts';
import { AppError, type CalendarEvent, type CalendarProvider, type Environment } from './types.ts';

type Envelope = { v: 1; owner: string; calendarId: string; generation: string; eventId: string; start: number; expiresAt: number; seriesId?: string; originalStartTime?: string };
const AUDIENCE = 'calendar-alarm:v1';
export class OccurrenceAlarms {
  constructor(private env: Environment, private store: Store, private http: Fetch, private now: () => number, private provider: (owner: string) => Promise<CalendarProvider>) {}
  get configured() { return Boolean(this.env.DISPATCHER_ORIGIN && this.env.ALARM_ENCRYPTION_KEY && this.env.ALARM_REGISTRATION_KEY && this.env.ALARM_CALLBACK_KEY); }
  private async id(e: Envelope) {
    const material = await crypto.subtle.importKey('raw', bytes(this.env.ALARM_ENCRYPTION_KEY!), 'HKDF', false, ['deriveBits']);
    const derived = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(AUDIENCE + ':logical-id') }, material, 256);
    return mac(base64(new Uint8Array(derived)), JSON.stringify([AUDIENCE, e.owner, e.calendarId, e.generation, e.seriesId ?? e.eventId, e.originalStartTime ?? e.eventId, e.start]));
  }
  async register(owner: string, calendarId: string, generation: string, event: CalendarEvent) {
    const start = Date.parse(event.start);
    if (!Number.isSafeInteger(start) || start <= this.now() || start > this.now() + MAX_HORIZON) return;
    await this.store.requireEnabled(owner, calendarId, generation);
    if (!await this.store.connection(owner)) throw new AppError(403, 'Calendar connection was revoked.');
    const e: Envelope = { v: 1, owner, calendarId, generation, eventId: event.providerEventId, start, expiresAt: start + LATE_WINDOW,
      ...(event.recurringEventId ? { seriesId: event.recurringEventId, originalStartTime: event.originalStartTime } : {}) };
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
  }
  async seed(owner: string, calendarId: string, generation: string, provider: CalendarProvider) {
    if (!this.configured) return;
    if (!provider.alarmCandidates) throw new AppError(503, 'Provider alarm discovery is unavailable.');
    for (const event of await provider.alarmCandidates(calendarId, this.now())) await this.register(owner, calendarId, generation, event);
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
        e.start !== job.dueAt || e.expiresAt !== job.expiresAt || await this.id(e) !== job.id) throw new Error();
    } catch { throw new AppError(403, 'Alarm envelope is not valid.'); }
    const ack = () => new Response(null, { status: 204 });
    if (this.now() < e.start) throw new AppError(409, 'Alarm is not due.');
    if (this.now() > e.expiresAt) {
      await this.store.run('DELETE FROM occurrence_outbox WHERE id = ? AND expires_at < ?', job.id, this.now());
      this.log(job.id, 'expired_cleanup', e.start); return ack();
    }
    const grant = await this.store.calendar(e.owner, e.calendarId);
    if (!grant?.enabled || grant.generation !== e.generation || !await this.store.connection(e.owner)) {
      this.log(job.id, 'consent_revoked', e.start); return ack();
    }
    const provider = await this.provider(e.owner);
    if (!provider.getOccurrence) throw new AppError(503, 'Provider occurrence lookup is unavailable.');
    let event: CalendarEvent | null;
    try { event = await provider.getOccurrence(e.calendarId, e.eventId); }
    catch (error) {
      if (error instanceof AppError && error.status === 403) { this.log(job.id, 'provider_access_revoked', e.start); return ack(); }
      throw error;
    }
    if (!event || event.status === 'cancelled' || event.calendarId !== e.calendarId || event.providerEventId !== e.eventId || Date.parse(event.start) !== e.start ||
      event.recurringEventId !== e.seriesId || event.originalStartTime !== e.originalStartTime) {
      this.log(job.id, 'stale_or_cancelled', e.start); return ack();
    }
    // Only a valid wake advances the chain. Register first; retries/dedup must not break the successor.
    if (e.seriesId) {
      if (!provider.nextOccurrence) throw new AppError(503, 'Provider recurrence lookup is unavailable.');
      const next = await provider.nextOccurrence(e.calendarId, e.seriesId, Math.max(e.start, this.now()));
      if (next) await this.register(e.owner, e.calendarId, e.generation, next);
    }
    // A single guarded INSERT claims due work. Status reads and snapshot replacement cannot delete it.
    const claimed = await this.store.claimDue(job.id, e.owner, e.calendarId, e.generation, event, e.start, this.now(), e.expiresAt);
    this.log(job.id, claimed ? 'due_work' : 'duplicate_or_revoked', e.start);
    return ack();
  }
}
