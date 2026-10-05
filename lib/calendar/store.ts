import { AppError, type Database, type CalendarEvent } from './types.ts';
export type CalendarRow = { owner: string; calendar_id: string; summary: string; enabled: number; generation: string };
export type WatchRow = { id: string; owner: string; calendar_id: string; generation: string; token_hash: string; resource_id: string | null; expiration: number; status: string; last_message: string | null; synced_at: number | null };
export class Store {
  constructor(private db: Database | undefined) { if (!db) throw new AppError(503, 'Persistent storage is unavailable.'); }
  statement(sql: string, ...values: unknown[]) { return this.db!.prepare(sql).bind(...values); }
  async run(sql: string, ...values: unknown[]) { await this.statement(sql, ...values).run(); }
  async first<T>(sql: string, ...values: unknown[]) { return this.statement(sql, ...values).first<T>(); }
  async all<T>(sql: string, ...values: unknown[]) { return (await this.statement(sql, ...values).all<T>()).results; }
  async connection(owner: string) { return this.first<{refresh_token: string}>('SELECT refresh_token FROM connections WHERE owner = ?', owner); }
  async calendar(owner: string, id: string) { return this.first<CalendarRow>('SELECT * FROM calendars WHERE owner = ? AND calendar_id = ?', owner, id); }
  async requireEnabled(owner: string, id: string, generation?: string) {
    const row = await this.calendar(owner, id);
    if (!row?.enabled || (generation && row.generation !== generation)) throw new AppError(403, 'This calendar is not enabled.');
    return row;
  }
  async disconnect(owner: string) {
    await this.db!.batch([
      this.statement('DELETE FROM subscriptions WHERE owner = ?', owner),
      this.statement('DELETE FROM subscription_attempts WHERE owner = ?', owner),
      this.statement('DELETE FROM connections WHERE owner = ?', owner),
      this.statement('DELETE FROM oauth_states WHERE owner = ?', owner),
      this.statement('DELETE FROM events WHERE owner = ?', owner),
      this.statement('DELETE FROM occurrence_outbox WHERE owner = ?', owner),
      this.statement('DELETE FROM calendars WHERE owner = ?', owner),
      this.statement("UPDATE watches SET status = 'revoked' WHERE owner = ?", owner),
    ]);
  }
  async revoke(owner: string, id: string, generation: string) {
    await this.db!.batch([
      this.statement('UPDATE calendars SET enabled = 0, generation = ? WHERE owner = ? AND calendar_id = ?', generation, owner, id),
      this.statement("UPDATE watches SET status = 'revoked' WHERE owner = ? AND calendar_id = ?", owner, id),
      this.statement('DELETE FROM subscriptions WHERE owner = ? AND calendar_id = ?', owner, id),
      this.statement('DELETE FROM subscription_attempts WHERE owner = ? AND calendar_id = ?', owner, id),
      this.statement('DELETE FROM events WHERE owner = ? AND calendar_id = ?', owner, id),
      this.statement('DELETE FROM occurrence_outbox WHERE owner = ? AND calendar_id = ?', owner, id),
    ]);
  }
  async replaceEvents(watch: WatchRow, events: CalendarEvent[], now: number) {
    // Generation and channel checks guard commits after consent revocation/renewal.
    const guard = `EXISTS (SELECT 1 FROM calendars c JOIN watches w ON w.owner = c.owner AND w.calendar_id = c.calendar_id WHERE c.owner = ? AND c.calendar_id = ? AND c.enabled = 1 AND c.generation = ? AND w.id = ? AND w.status = 'active' AND w.expiration > ?)`;
    const args = [watch.owner, watch.calendar_id, watch.generation, watch.id, now];
    await this.db!.batch([
      this.statement(`DELETE FROM events WHERE owner = ? AND calendar_id = ? AND ${guard}`, watch.owner, watch.calendar_id, ...args),
      ...events.map(event => this.statement(`INSERT OR REPLACE INTO events (owner, calendar_id, provider_event_id, payload) SELECT ?, ?, ?, ? WHERE ${guard}`, watch.owner, watch.calendar_id, event.providerEventId, JSON.stringify(event), ...args)),
      this.statement(`UPDATE watches SET synced_at = ?, sync_failed = CASE WHEN sync_failed = 2 THEN 1 ELSE 0 END WHERE id = ? AND ${guard}`, now, watch.id, ...args),
    ]);
  }
  async claimDue(id: string, owner: string, calendarId: string, generation: string, event: CalendarEvent, dueAt: number, now: number, expiresAt: number) {
    // Bounded retention. Expired envelopes cannot replay after this ledger is removed.
    await this.run('DELETE FROM occurrence_outbox WHERE id IN (SELECT id FROM occurrence_outbox WHERE created_at < ? ORDER BY created_at LIMIT 100)', now - 7 * 86400_000);
    const row = await this.first<{id: string}>(`INSERT INTO occurrence_outbox (id, owner, calendar_id, generation, provider_event_id, due_at, created_at, expires_at, payload, status)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending'
      WHERE ? >= ? AND ? <= ? AND EXISTS (SELECT 1 FROM connections WHERE owner = ?)
      AND EXISTS (SELECT 1 FROM calendars WHERE owner = ? AND calendar_id = ? AND enabled = 1 AND generation = ?)
      ON CONFLICT(id) DO NOTHING RETURNING id`, id, owner, calendarId, generation, event.providerEventId, dueAt, now, expiresAt, JSON.stringify(event),
      now, dueAt, now, expiresAt, owner, owner, calendarId, generation);
    return Boolean(row);
  }
}
