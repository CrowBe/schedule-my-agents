import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { Store, type WatchRow } from '../lib/calendar/store.ts';
import { CalendarMaintenance, CONVERGENCE_INTERVAL_MS, WATCH_RENEWAL_MARGIN_MS, type MaintenanceDependencies } from '../lib/calendar/maintenance.ts';
import type { Statement } from '../lib/calendar/types.ts';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const HOUR = 60 * 60_000;

function fixture() {
  const sql = new DatabaseSync(':memory:');
  for (const file of readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort()) sql.exec(readFileSync(`drizzle/${file}`, 'utf8'));
  class Prepared implements Statement {
    values: SQLInputValue[] = [];
    private query: string;
    constructor(query: string) { this.query = query; }
    bind(...values: unknown[]) { this.values = values as SQLInputValue[]; return this; }
    async first<T>() { return (sql.prepare(this.query).get(...this.values) ?? null) as T | null; }
    async all<T>() { return { results: sql.prepare(this.query).all(...this.values) as T[] }; }
    async run() { return sql.prepare(this.query).run(...this.values); }
  }
  const DB = { prepare: (q: string) => new Prepared(q), async batch(statements: Statement[]) {
    sql.exec('BEGIN'); try { for (const statement of statements) await statement.run(); sql.exec('COMMIT'); }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  } };
  const store = new Store(DB);
  sql.prepare('INSERT INTO connections (owner, refresh_token, created_at, provider_id, connection_id) VALUES (?, ?, ?, ?, ?)').run('owner', 'sealed', NOW - 86400_000, 'google', 'connection-1');
  const calendar = (id: string, enabled = 1, generation = `grant-${id}`) =>
    sql.prepare('INSERT INTO calendars (owner, calendar_id, summary, enabled, generation) VALUES (?, ?, ?, ?, ?)').run('owner', id, id, enabled, generation);
  const watch = (calendarId: string, values: { expiration?: number; synced_at?: number | null; sync_failed?: number; sync_until?: number; status?: string } = {}) => {
    const id = `watch-${calendarId}-${values.expiration ?? 0}`;
    sql.prepare(`INSERT INTO watches (id, owner, calendar_id, generation, token_hash, resource_id, expiration, status, synced_at, sync_failed, sync_until, provider_id, connection_id)
      VALUES (?, 'owner', ?, ?, 'hash', 'resource', ?, ?, ?, ?, ?, 'google', 'connection-1')`)
      .run(id, calendarId, `grant-${calendarId}`, values.expiration ?? NOW + 5 * 86400_000, values.status ?? 'active',
        values.synced_at === undefined ? NOW - 60_000 : values.synced_at, values.sync_failed ?? 0, values.sync_until ?? 0);
    return id;
  };
  const renewed: string[] = [], synced: string[] = [];
  const deps: MaintenanceDependencies = {
    store, now: () => NOW, ingressReady: async () => true,
    renewWatch: async (_owner, calendarId) => { renewed.push(calendarId); },
    syncWatch: async (row: WatchRow) => { synced.push(row.calendar_id); },
  };
  const run = (overrides: Partial<MaintenanceDependencies> = {}) => new CalendarMaintenance({ ...deps, ...overrides }).run();
  return { sql, store, calendar, watch, renewed, synced, run };
}

test('watches expiring within the renewal margin or already expired are renewed', async () => {
  const f = fixture();
  f.calendar('soon'); f.watch('soon', { expiration: NOW + WATCH_RENEWAL_MARGIN_MS - HOUR });
  f.calendar('expired'); f.watch('expired', { expiration: NOW - HOUR });
  f.calendar('edge'); f.watch('edge', { expiration: NOW + WATCH_RENEWAL_MARGIN_MS });
  const summary = await f.run();
  assert.deepEqual(f.renewed.sort(), ['edge', 'expired', 'soon']);
  // Renewal syncs the replacement watch itself.
  assert.deepEqual(f.synced, []);
  assert.equal(summary.watchesRenewed, 3);
  assert.equal(summary.calendarsConverged, 0);
  assert.equal(summary.checkedAt, NOW);
});

test('fresh unexpired watches are neither renewed nor synced', async () => {
  const f = fixture();
  f.calendar('fresh'); f.watch('fresh', { expiration: NOW + WATCH_RENEWAL_MARGIN_MS + HOUR, synced_at: NOW - CONVERGENCE_INTERVAL_MS + 60_000 });
  const summary = await f.run();
  assert.deepEqual([f.renewed, f.synced], [[], []]);
  assert.deepEqual({ ...summary, checkedAt: 0 }, { checkedAt: 0, watchesRenewed: 0, calendarsConverged: 0, cleanedUp: 0, failures: 0 });
});

test('failed, never-synced, and stale watches converge through syncWatch', async () => {
  const f = fixture();
  f.calendar('failed'); f.watch('failed', { sync_failed: 1 });
  f.calendar('busy-warning'); f.watch('busy-warning', { sync_failed: 2 });
  f.calendar('never'); f.watch('never', { synced_at: null });
  f.calendar('stale'); f.watch('stale', { synced_at: NOW - CONVERGENCE_INTERVAL_MS });
  const summary = await f.run();
  assert.deepEqual(f.synced.sort(), ['busy-warning', 'failed', 'never', 'stale']);
  assert.equal(summary.calendarsConverged, 4);
  assert.deepEqual(f.renewed, []);
});

test('a held sync lock skips convergence', async () => {
  const f = fixture();
  f.calendar('locked'); f.watch('locked', { sync_failed: 1, sync_until: NOW + 60_000 });
  assert.equal((await f.run()).calendarsConverged, 0);
  assert.deepEqual(f.synced, []);
});

test('calendars without an owner-started watch are never auto-watched', async () => {
  const f = fixture();
  f.calendar('never-watched');
  f.calendar('failed-watch'); f.watch('failed-watch', { status: 'failed', expiration: NOW - HOUR });
  f.calendar('revoked-watch'); f.watch('revoked-watch', { status: 'revoked', expiration: NOW + HOUR });
  const summary = await f.run();
  assert.deepEqual([f.renewed, f.synced], [[], []]);
  assert.equal(summary.failures, 0);
});

test('disabled calendars, other generations, and disconnected owners are not maintained', async () => {
  const f = fixture();
  f.calendar('disabled', 0); f.watch('disabled', { expiration: NOW - HOUR });
  f.calendar('regranted', 1, 'grant-new'); f.watch('regranted', { sync_failed: 1 }); // watch bound to grant-regranted
  await f.run();
  assert.deepEqual([f.renewed, f.synced], [[], []]);
  const g = fixture();
  g.calendar('orphan'); g.watch('orphan', { sync_failed: 1 });
  g.sql.exec("DELETE FROM connections");
  await g.run();
  assert.deepEqual(g.synced, []);
});

test('unverified ingress skips renewal and convergence', async () => {
  const f = fixture();
  f.calendar('soon'); f.watch('soon', { expiration: NOW + HOUR });
  f.calendar('stale'); f.watch('stale', { synced_at: null });
  const summary = await f.run({ ingressReady: async () => false });
  assert.deepEqual([f.renewed, f.synced], [[], []]);
  assert.equal(summary.failures, 0);
});

test('consent revoked during the run skips convergence and renewal for that calendar', async () => {
  const f = fixture();
  f.calendar('a'); f.watch('a', { sync_failed: 1 });
  f.calendar('b'); f.watch('b', { sync_failed: 1 });
  f.calendar('c'); f.watch('c', { expiration: NOW + HOUR });
  const summary = await f.run({
    syncWatch: async row => {
      f.synced.push(row.calendar_id);
      // While "a" syncs, the owner disables "b" and re-grants "c".
      f.sql.exec("UPDATE calendars SET enabled = 0, generation = 'revoked' WHERE calendar_id = 'b'");
      f.sql.exec("UPDATE calendars SET generation = 'regranted' WHERE calendar_id = 'c'");
    },
  });
  assert.deepEqual(f.synced, ['a']);
  assert.deepEqual(f.renewed, []);
  assert.equal(summary.calendarsConverged, 1);
});

test('one failing calendar does not stop the remaining calendars', async () => {
  const f = fixture();
  f.calendar('a-renew-fails'); f.watch('a-renew-fails', { expiration: NOW + HOUR });
  f.calendar('b-sync-fails'); f.watch('b-sync-fails', { sync_failed: 1 });
  f.calendar('c-ok'); f.watch('c-ok', { sync_failed: 1 });
  f.calendar('d-ok'); f.watch('d-ok', { expiration: NOW + HOUR });
  const logged: unknown[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { logged.push(args); };
  try {
    const summary = await f.run({
      renewWatch: async (_owner, id) => { if (id.startsWith('a')) throw new Error('provider said secret-token for alice@example.com'); f.renewed.push(id); },
      syncWatch: async row => { if (row.calendar_id.startsWith('b')) throw new Error('boom'); f.synced.push(row.calendar_id); },
    });
    assert.equal(summary.failures, 2);
    assert.equal(summary.watchesRenewed, 1);
    assert.equal(summary.calendarsConverged, 1);
    assert.deepEqual([f.renewed, f.synced], [['d-ok'], ['c-ok']]);
    const text = JSON.stringify(logged);
    assert.ok(!/secret-token|alice@example\.com|a-renew-fails|b-sync-fails/.test(text), text);
  } finally {
    console.warn = warn;
  }
});

test('maxPerTick bounds the calendars processed in one tick', async () => {
  const f = fixture();
  for (const id of ['a', 'b', 'c']) { f.calendar(id); f.watch(id, { sync_failed: 1 }); }
  assert.equal((await f.run({ maxPerTick: 2 })).calendarsConverged, 2);
});

test('expired OAuth states, subscription attempts, and subscriptions are cleaned up', async () => {
  const f = fixture();
  const state = f.sql.prepare('INSERT INTO oauth_states (state, owner, verifier, expires_at) VALUES (?, ?, ?, ?)');
  state.run('old', 'owner', 'v', NOW - 1); state.run('edge', 'owner', 'v', NOW); state.run('live', 'owner', 'v', NOW + HOUR);
  const attempt = f.sql.prepare("INSERT INTO subscription_attempts (id, owner, calendar_id, revision, expires_at) VALUES (?, 'owner', 'cal', 'r', ?)");
  attempt.run('old', NOW - 1); attempt.run('live', NOW + HOUR);
  const subscription = f.sql.prepare("INSERT INTO subscriptions (id, owner, calendar_id, generation, callback_url, secret, expires_at, verified_at, revision) VALUES (?, 'owner', 'cal', 'g', 'https://receiver.example/cb', 'sealed', ?, 1, 'r')");
  subscription.run('expired', NOW - 1); subscription.run('live', NOW + HOUR);
  const delivery = f.sql.prepare("INSERT INTO deliveries (outbox_id, subscription_id, owner, calendar_id, body, status, next_at) VALUES (?, ?, 'owner', 'cal', '{}', ?, 0)");
  delivery.run('o1', 'expired', 'pending'); delivery.run('o2', 'expired', 'accepted'); delivery.run('o3', 'live', 'pending');
  const summary = await f.run();
  assert.equal(summary.cleanedUp, 4);
  const ids = (table: string, column: string) => (f.sql.prepare(`SELECT ${column} AS id FROM ${table} ORDER BY 1`).all() as { id: string }[]).map(row => row.id);
  assert.deepEqual(ids('oauth_states', 'state'), ['live']);
  assert.deepEqual(ids('subscription_attempts', 'id'), ['live']);
  assert.deepEqual(ids('subscriptions', 'id'), ['live']);
  assert.deepEqual(ids('deliveries', 'outbox_id'), ['o2', 'o3']);
  // Idempotent: a second run finds nothing left to clean.
  assert.equal((await f.run()).cleanedUp, 0);
});

test('maxPerTick does not starve due watches behind fresh or unwatched calendars', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) {
    f.calendar(`a-unwatched-${i}`);
    f.calendar(`b-fresh-${i}`);
    f.watch(`b-fresh-${i}`, { expiration: NOW + 7 * 24 * HOUR, synced_at: NOW - 60_000 });
  }
  f.calendar('z-due');
  f.watch('z-due', { expiration: NOW + WATCH_RENEWAL_MARGIN_MS - 1_000 });
  const summary = await f.run({ maxPerTick: 2 });
  assert.equal(summary.watchesRenewed, 1);
  assert.deepEqual(f.renewed, ['z-due']);
});

test('cleanup scrubs expired occurrence_outbox payloads even without an alarm callback', async () => {
  const f = fixture();
  f.sql.prepare(`INSERT INTO occurrence_outbox (id, owner, calendar_id, generation, provider_event_id, due_at, created_at, expires_at, payload, provider_id, connection_id, status, event_name, agent_email)
    VALUES ('inv-1', 'owner', 'c1', 'g1', 'ev-1', ?, ?, ?, '{"title":"Private text"}', 'google', 'connection-1', 'ready', 'calendar.event.invited', 'agent@example.com')`)
    .run(NOW - 600_000, NOW - 600_000, NOW - 1);
  const summary = await f.run();
  assert.equal(summary.cleanedUp, 1);
  const row = f.sql.prepare('SELECT status, payload FROM occurrence_outbox WHERE id = ?').get('inv-1') as { status: string; payload: string };
  assert.deepEqual({ ...row }, { status: 'terminal', payload: '' });
});
