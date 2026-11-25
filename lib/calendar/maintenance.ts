import { digest } from './crypto.ts';
import type { Store, WatchRow } from './store.ts';

export const WATCH_RENEWAL_MARGIN_MS = 24 * 60 * 60_000; // renew watches within 24h of expiry
export const CONVERGENCE_INTERVAL_MS = 15 * 60_000; // converge missed pushes every 15m
const DEFAULT_MAX_PER_TICK = 50;

export type RenewalExpectation = { watchId: string; generation: string; connectionId: string };
export type MaintenanceDependencies = {
  store: Store;
  now: () => number;
  ingressReady: (owner: string) => Promise<boolean>;
  /** Rechecks authority, creates a replacement watch, syncs it, and revokes the old one. */
  renewWatch: (owner: string, calendarId: string, expected: RenewalExpectation) => Promise<void>;
  syncWatch: (watch: WatchRow) => Promise<void>;
  maxPerTick?: number;
};
export type MaintenanceSummary = {
  checkedAt: number;
  watchesRenewed: number;
  calendarsConverged: number;
  cleanedUp: number;
  failures: number;
};
type MaintenanceWatchRow = WatchRow & { sync_failed: number; sync_until: number };
type Grant = { owner: string; calendar_id: string; generation: string };

export class CalendarMaintenance {
  private deps: MaintenanceDependencies;
  constructor(deps: MaintenanceDependencies) { this.deps = deps; }

  async run(owner?: string): Promise<MaintenanceSummary> {
    const summary: MaintenanceSummary = { checkedAt: this.deps.now(), watchesRenewed: 0, calendarsConverged: 0, cleanedUp: 0, failures: 0 };
    try {
      summary.cleanedUp = await this.cleanup(owner);
    } catch (error) {
      summary.failures++;
      console.warn('calendar_maintenance_failed', { stage: 'cleanup', name: error instanceof Error ? error.name : 'unknown' });
    }
    // Select only enabled calendars whose active watch is due for renewal or convergence,
    // ordered by oldest sync / earliest expiry so fresh or unwatched calendars cannot starve due ones.
    const limit = this.deps.maxPerTick ?? DEFAULT_MAX_PER_TICK;
    const now = this.deps.now();
    const dueSql = `SELECT c.owner, c.calendar_id, c.generation FROM calendars c
      JOIN connections n ON n.owner = c.owner
      JOIN watches w ON w.owner = c.owner AND w.calendar_id = c.calendar_id AND w.generation = c.generation AND w.status = 'active'
      WHERE c.enabled = 1${owner ? ' AND c.owner = ?' : ''}
        AND w.id = (SELECT w2.id FROM watches w2 WHERE w2.owner = c.owner AND w2.calendar_id = c.calendar_id AND w2.generation = c.generation AND w2.status = 'active' ORDER BY w2.expiration DESC LIMIT 1)
        AND (w.expiration <= ? OR (w.sync_until <= ? AND (w.sync_failed > 0 OR w.synced_at IS NULL OR w.synced_at <= ?)))
      ORDER BY COALESCE(w.synced_at, 0) ASC, c.owner ASC, c.calendar_id ASC LIMIT ?`;
    const dueArgs = owner
      ? [owner, now + WATCH_RENEWAL_MARGIN_MS, now, now - CONVERGENCE_INTERVAL_MS, limit]
      : [now + WATCH_RENEWAL_MARGIN_MS, now, now - CONVERGENCE_INTERVAL_MS, limit];
    const grants = await this.deps.store.all<Grant>(dueSql, ...dueArgs);
    for (const grant of grants) {
      try {
        const outcome = await this.maintain(grant);
        if (outcome === 'renewed') summary.watchesRenewed++;
        if (outcome === 'converged') summary.calendarsConverged++;
      } catch (error) {
        summary.failures++;
        // Generation is a random grant identity, so its digest names nothing private.
        console.warn('calendar_maintenance_failed', { grantTag: (await digest(grant.generation)).slice(0, 12), name: error instanceof Error ? error.name : 'unknown' });
      }
    }
    console.info('calendar_maintenance', summary);
    return summary;
  }

  private async maintain(grant: Grant): Promise<'renewed' | 'converged' | 'skipped'> {
    const { store } = this.deps;
    if (!await this.deps.ingressReady(grant.owner)) return 'skipped';
    // A calendar the owner never started watching stays unwatched.
    const watch = await store.first<MaintenanceWatchRow>("SELECT * FROM watches WHERE owner = ? AND calendar_id = ? AND generation = ? AND status = 'active' ORDER BY expiration DESC LIMIT 1",
      grant.owner, grant.calendar_id, grant.generation);
    if (!watch) return 'skipped';
    const now = this.deps.now();
    if (watch.expiration <= now + WATCH_RENEWAL_MARGIN_MS) {
      if (!await this.stillAuthorized(grant)) return 'skipped';
      await this.deps.renewWatch(grant.owner, grant.calendar_id, {
        watchId: watch.id, generation: grant.generation, connectionId: watch.connection_id,
      });
      return 'renewed';
    }
    const stale = watch.sync_failed > 0 || watch.synced_at === null || now - watch.synced_at >= CONVERGENCE_INTERVAL_MS;
    if (watch.sync_until > now || !stale) return 'skipped';
    if (!await this.stillAuthorized(grant)) return 'skipped';
    await this.deps.syncWatch(watch);
    return 'converged';
  }

  // Earlier calendars' provider calls can outlast a revocation of this one.
  private async stillAuthorized(grant: Grant) {
    return Boolean(await this.deps.store.first(`SELECT 1 FROM calendars c JOIN connections n ON n.owner = c.owner
      WHERE c.owner = ? AND c.calendar_id = ? AND c.enabled = 1 AND c.generation = ?`, grant.owner, grant.calendar_id, grant.generation));
  }

  private async cleanup(owner?: string) {
    const { store } = this.deps, now = this.deps.now();
    const filter = owner ? 'expires_at <= ? AND owner = ?' : 'expires_at <= ?';
    const args = owner ? [now, owner] : [now];
    const states = await store.all(`DELETE FROM oauth_states WHERE ${filter} RETURNING state`, ...args);
    const attempts = await store.all(`DELETE FROM subscription_attempts WHERE ${filter} RETURNING id`, ...args);
    const expired = await store.first<{ count: number }>(`SELECT count(*) AS count FROM subscriptions WHERE ${filter}`, ...args);
    const expiredOutbox = await store.first<{ count: number }>(`SELECT count(*) AS count FROM occurrence_outbox WHERE ${filter} AND (payload != '' OR status = 'pending')`, ...args);
    // Accepted receipts stay as delivery evidence; unsent work for a lapsed subscription is dropped with it.
    // Expired outbox rows have private event text scrubbed immediately even without an alarm retry.
    await store.batch([
      store.statement(`DELETE FROM deliveries WHERE status != 'accepted' AND subscription_id IN (SELECT id FROM subscriptions WHERE ${filter})`, ...args),
      store.statement(`DELETE FROM subscriptions WHERE ${filter}`, ...args),
      store.statement(`UPDATE deliveries SET status = 'exhausted', body = '', lease = NULL, lease_until = 0 WHERE status = 'pending' AND outbox_id IN (SELECT id FROM occurrence_outbox WHERE ${filter})`, ...args),
      store.statement(`UPDATE occurrence_outbox SET status = 'terminal', payload = '' WHERE ${filter} AND (payload != '' OR status = 'pending')`, ...args),
    ]);
    return states.length + attempts.length + (expired?.count ?? 0) + (expiredOutbox?.count ?? 0);
  }
}
