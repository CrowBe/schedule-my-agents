import { signedHeaders } from './subscriptions.ts';
import type { CalendarEvent } from './types.ts';

export const MAX_EVENT_BYTES = 262_144;
/** Serialize once when creating delivery work; persist this body unchanged across attempts. */
export function serializeOccurrence(eventId: string, occurrence: CalendarEvent) {
  if (!eventId || eventId === occurrence.providerEventId || occurrence.status === 'cancelled' || !Number.isFinite(Date.parse(occurrence.start))) {
    throw new Error('Invalid event identity or occurrence.');
  }
  const data = {
    calendarId: occurrence.calendarId, eventId: occurrence.providerEventId,
    start: occurrence.start,
    ...(occurrence.end !== undefined ? { end: occurrence.end } : {}),
    ...(occurrence.title !== undefined ? { title: occurrence.title } : {}),
    ...(occurrence.description !== undefined ? { description: occurrence.description } : {}),
  };
  const body = JSON.stringify({ eventId, name: 'calendar.event.starting', timestamp: new Date(occurrence.start).toISOString(), data, cursor: null });
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

// The original opaque alarm remains unacknowledged while work needs recovery.
// Its durable retries drive this ledger; no additional scheduler is introduced.
import { Subscriptions, type CallbackTransport } from './subscriptions.ts';
import { digest, open, random } from './crypto.ts';
import { Store } from './store.ts';
import { AppError, type Environment } from './types.ts';
type Receipt = { id: string; owner: string; calendar_id: string; generation: string; payload: string; expires_at: number; status: string };
type Delivery = { subscription_id: string; body: string; attempts: number; lease: string };
const MAX_ATTEMPTS = 6;
export class Deliveries {
  constructor(private store: Store, private env: Environment, private now: () => number, private transport?: CallbackTransport) {}
  async dispatch(id: string, current: CalendarEvent) {
    const receipt = await this.store.first<Receipt>('SELECT * FROM occurrence_outbox WHERE id = ?', id);
    if (!receipt || receipt.status === 'terminal') return;
    if (receipt.expires_at < this.now()) {
      await this.store.run("UPDATE deliveries SET status = 'exhausted', body = '' WHERE outbox_id = ? AND status = 'pending'", id);
      return;
    }
    let body: string;
    try {
      body = serializeOccurrence('evt_' + id, JSON.parse(receipt.payload));
      if (serializeOccurrence('evt_' + id, current) !== body) throw new Error('Occurrence changed.');
    } catch {
      await this.store.batch([
        this.store.statement("UPDATE occurrence_outbox SET status = 'terminal' WHERE id = ?", id),
        this.store.statement("UPDATE deliveries SET status = 'terminal', body = '' WHERE outbox_id = ? AND status = 'pending'", id),
      ]);
      return;
    }
    // Atomic initialization freezes the audience at the first dispatch. Later subscribers
    // do not receive a past event, and restart cannot recreate accepted delivery rows.
    await this.store.batch([
      this.store.statement(`INSERT INTO deliveries (outbox_id, subscription_id, owner, calendar_id, body, next_at)
        SELECT o.id, s.id, o.owner, o.calendar_id, ?, ? FROM occurrence_outbox o
        JOIN subscriptions s ON s.owner = o.owner AND s.calendar_id = o.calendar_id AND s.generation = o.generation
        JOIN calendars c ON c.owner = o.owner AND c.calendar_id = o.calendar_id AND c.generation = o.generation AND c.enabled = 1
        JOIN connections n ON n.owner = o.owner
        WHERE o.id = ? AND o.status = 'pending' AND s.expires_at > ? AND s.verified_at > 0
        ON CONFLICT(outbox_id, subscription_id) DO NOTHING`, body, this.now(), id, this.now()),
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
      let outcome: 'accepted' | 'terminal' | 'retry' = 'terminal', status: number | null = null;
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
          const owned = await this.store.first<{lease: string}>("SELECT lease FROM deliveries WHERE outbox_id = ? AND subscription_id = ? AND lease = ? AND status = 'pending'", id, subscription.id, lease);
          if (active?.revision === subscription.revision && owned && this.now() <= receipt.expires_at && this.now() < now + 15_000) {
            const signal = AbortSignal.timeout(10_000);
            let abort!: () => void;
            const timeout = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
            try {
              const response = await Promise.race([this.transport.post(subscription.callback_url, delivery.body, headers, signal), timeout]);
              status = response.status; outcome = response.redirected ? 'terminal' : deliveryOutcome(status);
              void response.body?.cancel().catch(() => {});
            } finally { signal.removeEventListener('abort', abort); }
          } else if (active && active.revision !== subscription.revision) outcome = 'retry';
        } catch { outcome = 'retry'; }
      }
      const final = outcome === 'retry' ? (delivery.attempts >= MAX_ATTEMPTS || this.now() >= receipt.expires_at ? 'exhausted' : 'pending') : outcome;
      await this.store.run(`UPDATE deliveries SET status = ?, last_status = ?, next_at = ?, lease = NULL, lease_until = 0,
        body = CASE WHEN ? = 'pending' THEN body ELSE '' END WHERE outbox_id = ? AND subscription_id = ? AND lease = ?`,
        final, status, this.now() + Math.min(60_000, 2000 * 2 ** (delivery.attempts - 1)), final, id, row.subscription_id, lease);
      console.info('calendar_delivery', { eventTag: id.slice(0,12), subscriptionTag: (await digest(row.subscription_id)).slice(0,12), outcome: final, attempt: delivery.attempts, status });
    }
    const pending = await this.store.first<{n: number}>("SELECT count(*) n FROM deliveries WHERE outbox_id = ? AND status = 'pending'", id);
    if (pending?.n) throw new AppError(503, 'Delivery is pending durable retry.');
  }
}
