import { signedHeaders } from './subscriptions.ts';
import type { CalendarEvent, CalendarEventName } from './types.ts';

import type { EventProvenance } from './provenance.ts';

type EventDetails = {
  name?: CalendarEventName;
  agentEmail?: string;
  leadTimeMinutes?: number;
  provenance?: EventProvenance;
  timestamp?: number;
};
export const MAX_EVENT_BYTES = 262_144;
/** Serialize once when creating delivery work; persist this body unchanged across attempts. */
export function serializeOccurrence(eventId: string, occurrence: CalendarEvent, details: EventDetails = {}) {
  if (!eventId || eventId === occurrence.providerEventId || occurrence.status === 'cancelled' || !Number.isFinite(Date.parse(occurrence.start))) {
    throw new Error('Invalid event identity or occurrence.');
  }
  const data = {
    calendarId: occurrence.calendarId, eventId: occurrence.providerEventId,
    start: new Date(occurrence.start).toISOString(),
    ...(occurrence.end !== undefined ? { end: new Date(occurrence.end).toISOString() } : {}),
    ...(occurrence.title !== undefined ? { title: occurrence.title } : {}),
    ...(occurrence.description !== undefined ? { description: occurrence.description } : {}),
    ...(details.agentEmail ? { agentEmail: details.agentEmail } : {}),
    ...(details.leadTimeMinutes ? { leadTimeMinutes: details.leadTimeMinutes } : {}),
    ...(details.provenance ? { provenance: details.provenance } : {}),
  };
  const body = JSON.stringify({ eventId, name: details.name ?? 'calendar.event.starting', timestamp: details.timestamp === undefined ? data.start : new Date(details.timestamp).toISOString(), data, cursor: null });
  if (new TextEncoder().encode(body).byteLength > MAX_EVENT_BYTES) throw new Error('Event payload exceeds 256 KiB.');
  return body;
}

/** Rotation signatures cover the same exact bytes, identity and fresh attempt timestamp. */
export async function deliveryHeaders(secret: string, previousSecret: string | null, rotationUntil: number | null, eventId: string, subscriptionId: string, body: string, now: number) {
  const headers = await signedHeaders(secret, eventId, subscriptionId, body, now);
  if (previousSecret && rotationUntil !== null && rotationUntil > now) {
    const previous = await signedHeaders(previousSecret, eventId, subscriptionId, body, now);
    headers['webhook-signature'] += ' ' + previous['webhook-signature'];
  }
  return headers;
}

export function deliveryOutcome(status: number): 'accepted' | 'terminal' | 'retry' {
  if (status >= 200 && status < 300) return 'accepted';
  if (status === 410 || status === 413 || (status >= 300 && status < 400)) return 'terminal';
  return 'retry';
}

/** Equal jitter keeps a positive delay; receiver hints are a minimum, never a new lifetime. */
export function retryDelay(attempt: number, now: number, hint: string | null, random: () => number = Math.random) {
  const base = Math.min(60_000, 2000 * 2 ** Math.min(Math.max(0, attempt - 1), 5));
  const sample = random();
  const jitter = Math.floor(base / 2 + base / 2 * (Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 1));
  let delay = 0;
  if (hint && hint.length <= 128) {
    if (/^\d+$/.test(hint)) delay = Number(hint) * 1000;
    else if (/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(hint)) {
      const parsed = Date.parse(hint);
      if (Number.isFinite(parsed) && new Date(parsed).toUTCString() === hint) delay = parsed - now;
    }
  }
  return Math.max(jitter, Number.isNaN(delay) ? 0 : delay);
}

// The original opaque alarm remains unacknowledged while work needs recovery.
// Its durable retries drive this ledger; no additional scheduler is introduced.
import { Subscriptions, type CallbackTransport } from './subscriptions.ts';
import { digest, open, random } from './crypto.ts';
import { Store, connectionIdentity } from './store.ts';
import { AppError, ProviderFailure, type Environment } from './types.ts';
type Delivery = { subscription_id: string; body: string; attempts: number; lease: string };
const MAX_ATTEMPTS = 6;
export class PendingDelivery extends AppError {
  constructor() { super(503, 'Delivery is pending durable retry.'); }
}
export class Deliveries {
  private store: Store;
  private env: Environment;
  private now: () => number;
  private transport?: CallbackTransport;
  private random: () => number;
  constructor(store: Store, env: Environment, now: () => number, transport?: CallbackTransport, random: () => number = Math.random) {
    this.store = store; this.env = env; this.now = now; this.transport = transport; this.random = random;
  }
  async terminal(id: string) {
    await this.store.batch([
      this.store.statement("UPDATE occurrence_outbox SET status = 'terminal', payload = '' WHERE id = ?", id),
      this.store.statement("UPDATE deliveries SET status = 'terminal', body = '', lease = NULL, lease_until = 0 WHERE outbox_id = ? AND status = 'pending'", id),
    ]);
  }
  async dispatch(id: string, current: CalendarEvent, lookup?: () => Promise<CalendarEvent | null>) {
    const receipt = await this.store.outbox(id);
    if (!receipt || receipt.status === 'terminal') return;
    const connection = await this.store.connection(receipt.owner);
    if (!connection || connection.providerId !== receipt.provider_id ||
      (receipt.connection_id ? connection.id !== receipt.connection_id : !connection.legacy) ||
      current.calendarId !== receipt.calendar_id || current.providerEventId !== receipt.provider_event_id) {
      await this.terminal(id);
      return;
    }
    if (receipt.expires_at <= this.now()) {
      await this.store.batch([
        this.store.statement("UPDATE occurrence_outbox SET status = 'terminal', payload = '' WHERE id = ?", id),
        this.store.statement("UPDATE deliveries SET status = 'exhausted', body = '', lease = NULL, lease_until = 0 WHERE outbox_id = ? AND status = 'pending'", id),
      ]);
      return;
    }
    const invited = receipt.event_name === 'calendar.event.invited';
    const authority = (event: CalendarEvent) => this.store.authorizeEvent(connection, receipt.generation, event, receipt.agent_email, receipt.event_name);
    const route = await authority(current);
    const eventId = 'evt_' + id;
    const routed = (value: typeof route) => value && value.invitationId === receipt.invitation_id &&
      value.provenance.organizerEmail === route?.provenance.organizerEmail &&
      value.provenance.externalInvite === route?.provenance.externalInvite;
    if (!routed(route)) {
      await this.terminal(id);
      return;
    }
    let body: string;
    let matchesOccurrence: (event: CalendarEvent) => boolean;
    try {
      const original = JSON.parse(receipt.payload) as CalendarEvent;
      const details = {
        name: receipt.event_name, agentEmail: receipt.agent_email, leadTimeMinutes: receipt.lead_time_minutes,
        timestamp: invited || receipt.lead_time_minutes ? receipt.due_at : undefined,
      };
      const legacyPayload = !invited && !receipt.agent_email && !receipt.lead_time_minutes &&
        original.organizerEmail === undefined && original.organizerSelf === undefined && original.creatorEmail === undefined;
      const originalBody = serializeOccurrence(eventId, original, details);
      matchesOccurrence = event => event.status !== 'cancelled' &&
        event.seriesId === original.seriesId &&
        (event.recurrenceId === original.recurrenceId || (event.provider === 'google' && event.recurrenceId !== undefined && original.recurrenceId !== undefined &&
          Date.parse(event.recurrenceId) === Date.parse(original.recurrenceId))) &&
        (legacyPayload || (original.organizerEmail === event.organizerEmail && original.organizerSelf === event.organizerSelf &&
          original.creatorEmail === event.creatorEmail)) && serializeOccurrence(eventId, event, details) === originalBody;
      if (!matchesOccurrence(current)) throw new Error('Occurrence changed.');
      body = serializeOccurrence(eventId, original, { ...details, provenance: route!.provenance });
    } catch {
      await this.terminal(id);
      return;
    }
    // Freeze each alias's audience atomically. A late subscription cannot pick up a past receipt.
    await this.store.batch([
      this.store.statement(`INSERT INTO deliveries (outbox_id, subscription_id, owner, calendar_id, body, next_at)
        SELECT o.id, s.id, o.owner, o.calendar_id, ?, ? FROM occurrence_outbox o
        JOIN subscriptions s ON s.owner = o.owner AND s.calendar_id = o.calendar_id AND s.generation = o.generation
          AND s.event_name = o.event_name AND s.agent_email = o.agent_email AND s.lead_time_minutes = o.lead_time_minutes
        JOIN calendars c ON c.owner = o.owner AND c.calendar_id = o.calendar_id AND c.generation = o.generation AND c.enabled = 1
        WHERE o.id = ? AND o.status = 'pending' AND o.expires_at > ? AND s.expires_at > ? AND s.verified_at > 0
          AND EXISTS (SELECT 1 FROM connections WHERE owner = o.owner AND provider_id = o.provider_id AND ${connectionIdentity} = ?)
          AND (s.agent_email = '' OR EXISTS (SELECT 1 FROM agent_aliases a WHERE a.owner = s.owner AND a.email = s.agent_email))
        ON CONFLICT(outbox_id, subscription_id) DO NOTHING`, body, this.now(), id, this.now(), this.now(), connection.id),
      this.store.statement("UPDATE occurrence_outbox SET status = 'ready' WHERE id = ? AND status = 'pending'", id),
    ]);
    await this.store.run("UPDATE deliveries SET status = 'exhausted', body = '' WHERE outbox_id = ? AND status = 'pending' AND attempts >= ? AND lease_until <= ?", id, MAX_ATTEMPTS, this.now());
    const rows = await this.store.all<{subscription_id: string}>("SELECT subscription_id FROM deliveries WHERE outbox_id = ? AND status = 'pending' AND next_at <= ? AND lease_until <= ? ORDER BY next_at LIMIT 1", id, this.now(), this.now());
    const subscriptions = new Subscriptions(this.store, this.env, this.now, this.transport);
    for (const row of rows) {
      const lease = random(), now = this.now();
      const delivery = await this.store.first<Delivery>(`UPDATE deliveries SET lease = ?, lease_until = ?, attempts = attempts + 1
        WHERE outbox_id = ? AND subscription_id = ? AND status = 'pending' AND next_at <= ? AND lease_until <= ? AND attempts < ?
        AND EXISTS (SELECT 1 FROM occurrence_outbox WHERE id = ? AND expires_at >= ?)
        RETURNING subscription_id, body, attempts, lease`, lease, now + 15_000, id, row.subscription_id, now, now, MAX_ATTEMPTS, id, now);
      if (!delivery) continue;
      let outcome: 'accepted' | 'terminal' | 'retry' = 'terminal', status: number | null = null, retryAfter: string | null = null;
      const subscription = await subscriptions.active(row.subscription_id, receipt.owner);
      if (subscription && subscription.generation === receipt.generation && subscription.calendar_id === receipt.calendar_id && subscription.verified_at > 0) {
        if (!this.transport) throw new AppError(503, 'Callback transport is unavailable.');
        try {
          const secret = await open(subscription.secret, this.env.TOKEN_ENCRYPTION_KEY, `${receipt.owner}:${subscription.id}`);
          const previous = subscription.previous_secret && subscription.rotation_until! > this.now()
            ? await open(subscription.previous_secret, this.env.TOKEN_ENCRYPTION_KEY, `${receipt.owner}:${subscription.id}`) : null;
          const headers = await deliveryHeaders(secret, previous, subscription.rotation_until, 'evt_' + id, subscription.id, delivery.body, this.now());
          // Recheck after asynchronous crypto and immediately before the network effect.
          const active = await subscriptions.active(subscription.id, receipt.owner);
          const live = receipt.agent_email && lookup ? await lookup() : current;
          const stillRouted = live && matchesOccurrence(live) && routed(await authority(live));
          const owned = await this.store.first<{lease: string}>(`SELECT d.lease FROM deliveries d
            JOIN occurrence_outbox o ON o.id = d.outbox_id AND o.status = 'ready'
            JOIN subscriptions s ON s.id = d.subscription_id AND s.revision = ? AND s.expires_at > ?
            JOIN calendars c ON c.owner = o.owner AND c.calendar_id = o.calendar_id AND c.enabled = 1 AND c.generation = o.generation
            WHERE d.outbox_id = ? AND d.subscription_id = ? AND d.lease = ? AND d.status = 'pending'
              AND EXISTS (SELECT 1 FROM connections WHERE owner = o.owner AND provider_id = o.provider_id AND ${connectionIdentity} = ?)
              AND (o.agent_email = '' OR EXISTS (SELECT 1 FROM agent_aliases a WHERE a.owner = o.owner AND a.email = o.agent_email))`,
            subscription.revision, this.now(), id, subscription.id, lease, connection.id);
          if (active?.revision === subscription.revision && stillRouted && owned) {
            // Preparation consumes the lease too. Stop the network effect before
            // another worker can reclaim it, leaving a second for cancellation.
            const budget = Math.min(10_000, now + 14_000 - this.now(), receipt.expires_at - this.now());
            if (budget <= 0) throw new Error('Delivery preparation consumed the send budget.');
            const signal = AbortSignal.timeout(budget);
            let abort!: () => void;
            const timeout = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
            try {
              const response = await Promise.race([this.transport.post(subscription.callback_url, delivery.body, headers, signal, 'status'), timeout]);
              status = response.status; outcome = response.redirected ? 'terminal' : deliveryOutcome(status);
              retryAfter = response.headers.get('Retry-After');
              void response.body?.cancel().catch(() => {});
            } finally { signal.removeEventListener('abort', abort); }
          } else if (!stillRouted) {
            await this.terminal(id);
          } else if (active && active.revision !== subscription.revision) {
            outcome = 'retry';
          }
        } catch (error) {
          outcome = error instanceof ProviderFailure && error.kind !== 'transient' ? 'terminal' : 'retry';
        }
      }
      const completedAt = this.now();
      const delay = outcome === 'retry' ? retryDelay(delivery.attempts, completedAt, retryAfter, this.random) : 0;
      const final = outcome === 'retry' ? (delivery.attempts >= MAX_ATTEMPTS || completedAt + delay >= receipt.expires_at ? 'exhausted' : 'pending') : outcome;
      await this.store.run(`UPDATE deliveries SET status = ?, last_status = ?, next_at = ?, lease = NULL, lease_until = 0,
        body = CASE WHEN ? = 'pending' THEN body ELSE '' END WHERE outbox_id = ? AND subscription_id = ? AND lease = ?`,
        final, status, Math.min(receipt.expires_at, completedAt + delay), final, id, row.subscription_id, lease);
      console.info('calendar_delivery', { eventTag: id.slice(0,12), subscriptionTag: (await digest(row.subscription_id)).slice(0,12), outcome: final, attempt: delivery.attempts, status });
    }
    const pending = await this.store.first<{n: number}>("SELECT count(*) n FROM deliveries WHERE outbox_id = ? AND status = 'pending'", id);
    if (pending?.n) throw new PendingDelivery();
  }
}
