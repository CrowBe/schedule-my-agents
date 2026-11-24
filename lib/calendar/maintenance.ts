import { digest } from './crypto.ts';
import type { Store, WatchRow } from './store.ts';

export const WATCH_RENEWAL_MARGIN_MS = 24 * 60 * 60_000; // renew watches within 24h of expiry
export const CONVERGENCE_INTERVAL_MS = 15 * 60_000; // converge missed pushes every 15m
const DEFAULT_MAX_PER_TICK = 50;

export type MaintenanceDependencies = {
  store: Store;
  now: () => number;
  ingressReady: (owner: string) => Promise<boolean>;
  /** Rechecks authority, creates a replacement watch, syncs it, and revokes the old one. */
  renewWatch: (owner: string, calendarId: string) => Promise<void>;
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
    // Only explicitly enabled calendars on a live connection. Discovery grants nothing.
    const limit = this.deps.maxPerTick ?? DEFAULT_MAX_PER_TICK;
    const grants = owner
      ? await this.deps.store.all<Grant>(`SELECT c.owner, c.calendar_id, c.generation FROM calendars c JOIN connections n ON n.owner = c.owner
          WHERE c.enabled = 1 AND c.owner = ? ORDER BY c.calendar_id LIMIT ?`, owner, limit)
      : await this.deps.store.all<Grant>(`SELECT c.owner, c.calendar_id, c.generation FROM calendars c JOIN connections n ON n.owner = c.owner
          WHERE c.enabled = 1 ORDER BY c.owner, c.calendar_id LIMIT ?`, limit);
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
      await this.deps.renewWatch(grant.owner, grant.calendar_id);
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
    // Accepted receipts stay as delivery evidence; unsent work for a lapsed subscription is dropped with it.
    await store.batch([
      store.statement(`DELETE FROM deliveries WHERE status != 'accepted' AND subscription_id IN (SELECT id FROM subscriptions WHERE ${filter})`, ...args),
      store.statement(`DELETE FROM subscriptions WHERE ${filter}`, ...args),
    ]);
    return states.length + attempts.length + (expired?.count ?? 0);
  }
}
