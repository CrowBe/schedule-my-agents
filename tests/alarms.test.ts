import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { OccurrenceAlarms } from '../lib/calendar/alarms.ts';
import { CalendarService } from '../lib/calendar/service.ts';
import { GoogleCalendar, normalize } from '../lib/calendar/google.ts';
import { open } from '../lib/calendar/crypto.ts';
import { Store } from '../lib/calendar/store.ts';
import { signedHeaders, CALLBACK_PATH, type AlarmJob } from '../shared/alarm.ts';
import type { CalendarEvent, CalendarProvider, Environment, Statement } from '../lib/calendar/types.ts';

function fixture() {
  const sql = new DatabaseSync(':memory:');
  for (const f of readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort()) sql.exec(readFileSync(`drizzle/${f}`, 'utf8'));
  class Prepared implements Statement {
    values: SQLInputValue[] = [];
    constructor(private query: string) {}
    bind(...values: unknown[]) { this.values = values as SQLInputValue[]; return this; }
    async first<T>() { return (sql.prepare(this.query).get(...this.values) ?? null) as T | null; }
    async all<T>() { return { results: sql.prepare(this.query).all(...this.values) as T[] }; }
    async run() { return sql.prepare(this.query).run(...this.values); }
  }
  const DB = { prepare: (q: string) => new Prepared(q), async batch(s: Statement[]) { sql.exec('BEGIN'); try { for (const p of s) await p.run(); sql.exec('COMMIT'); } catch (e) { sql.exec('ROLLBACK'); throw e; } } };
  const env: Environment = { DB, SITE_ORIGIN: 'https://site.example', DISPATCHER_ORIGIN: 'https://alarm.example',
    ALARM_ENCRYPTION_KEY: btoa('e'.repeat(32)), ALARM_CALLBACK_KEY: btoa('c'.repeat(32)), ALARM_REGISTRATION_KEY: btoa('r'.repeat(32)) };
  let now = Date.parse('2026-10-06T23:00:00Z');
  let event: CalendarEvent | null = normalize('private-calendar', { id: 'private-event', summary: 'Secret appointment', start: { dateTime: new Date(now + 60_000).toISOString() } })!;
  const store = new Store(DB);
  sql.prepare('INSERT INTO connections VALUES (?, ?, ?)').run('private-owner', 'encrypted-refresh', now);
  sql.prepare('INSERT INTO calendars VALUES (?, ?, ?, 1, ?)').run('private-owner', 'private-calendar', 'Personal', 'grant-1');
  const jobs: AlarmJob[] = []; let failure = false; let lookupHook = async () => {};
  let next: CalendarEvent | null = null; let successors = 0;
  const provider: CalendarProvider = {
    discoverCalendars: async () => [], stopWatchingCalendar: async () => {}, watchCalendar: async () => { throw new Error(); },
    syncEvents: async () => event ? [event] : [], alarmCandidates: async () => event ? [event] : [],
    getOccurrence: async () => { await lookupHook(); if (failure) throw new Error('temporary'); return event; },
    nextOccurrence: async () => { successors++; return next; },
  };
  const http: typeof fetch = async (_url, init) => { if (failure) throw new Error('temporary'); const job = JSON.parse(String(init?.body)) as AlarmJob; jobs.push(job); return Response.json({ registered: true, id: job.id }); };
  const service = () => new CalendarService(env, { now: () => now, provider: async () => provider, http });
  const alarms = () => new OccurrenceAlarms(env, store, http, () => now, async () => provider);
  return { sql, env, jobs, store, alarms, service, get event() { return event!; }, setEvent: (e: CalendarEvent | null) => { event = e; }, setNext: (e: CalendarEvent | null) => { next = e; }, get successors() { return successors; },
    setNow: (n: number) => { now = n; }, setFailure: (v: boolean) => { failure = v; }, hook: (h: () => Promise<void>) => { lookupHook = h; },
    async register() { await alarms().register('private-owner', 'private-calendar', 'grant-1', event!); return jobs.at(-1)!; },
    async wake(job: AlarmJob, signed = true) { const body = JSON.stringify(job); return service().handle(new Request(env.SITE_ORIGIN + CALLBACK_PATH, { method: 'POST', body, headers: signed ? await signedHeaders(env.ALARM_CALLBACK_KEY!, CALLBACK_PATH, body, now) : {} })); } };
}

test('encrypted alarm → live revalidation → restart/concurrent deduplicated due work; status reads preserve due state', async () => {
  const f = fixture(); const job = await f.register();
  for (const value of ['private-owner', 'private-calendar', 'private-event', 'Secret appointment']) assert.ok(!JSON.stringify(job).includes(value));
  const decrypted = JSON.parse(await open(job.envelope, f.env.ALARM_ENCRYPTION_KEY, 'calendar-alarm:v1'));
  assert.equal(decrypted.owner, 'private-owner'); assert.ok(!('title' in decrypted));
  assert.equal((await f.wake(job)).status, 409);
  f.setNow(job.dueAt + 1000);
  assert.equal((await f.wake(job, false)).status, 403);
  for (const response of await Promise.all([f.wake(job), f.wake(job), f.wake(job)])) assert.equal(response.status, 204);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM occurrence_outbox').get()!.n, 1);
  assert.equal((await f.service().handle(new Request(f.env.SITE_ORIGIN + '/api/status', { headers: { 'oai-authenticated-user-id': 'private-owner' } }))).status, 200);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM occurrence_outbox').get()!.n, 1);
  assert.equal((await f.wake({ ...job, envelope: job.envelope.slice(0, -4) + 'aaaa' })).status, 403);
  f.setNow(job.expiresAt + 86400_000);
  assert.equal((await f.wake(job)).status, 204);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM occurrence_outbox').get()!.n, 0);
  assert.equal((await f.wake(job)).status, 204);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM occurrence_outbox').get()!.n, 0, 'expired replay cannot restore cleaned due work');
});

test('series moves 10 → noon: stale alarm does not advance; valid noon alarm registers only next instance', async () => {
  const f = fixture(); f.setEvent({ ...f.event, recurringEventId: 'private-series', originalStartTime: f.event.start });
  const old = await f.register(); const moved = { ...f.event, start: new Date(old.dueAt + 2 * 3600_000).toISOString() };
  f.setEvent(moved); const fresh = await f.register(); assert.notEqual(old.id, fresh.id);
  f.setNext({ ...moved, providerEventId: 'following-instance', originalStartTime: new Date(fresh.dueAt + 7 * 86400_000).toISOString(), start: new Date(fresh.dueAt + 7 * 86400_000).toISOString() });
  f.setNow(old.dueAt); assert.equal((await f.wake(old)).status, 204); assert.equal(f.successors, 0);
  f.setNow(fresh.dueAt + 1000); assert.equal((await f.wake(fresh)).status, 204); assert.equal(f.successors, 1);
  assert.equal(f.jobs.length, 3); assert.equal(f.jobs[2].dueAt, fresh.dueAt + 7 * 86400_000);
  // Replayed callback can retry successor registration, but its logical ID is stable.
  assert.equal((await f.wake(fresh)).status, 204); assert.equal(f.jobs[2].id, f.jobs[3].id);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM occurrence_outbox').get()!.n, 1);
});

test('cancellation, consent generation changes and revoke-during-fetch prevent due claims; transient provider failure retries', async () => {
  const f = fixture(); const job = await f.register(); f.setNow(job.dueAt);
  f.setFailure(true); assert.equal((await f.wake(job)).status, 503); f.setFailure(false);
  f.setEvent(null); assert.equal((await f.wake(job)).status, 204);
  f.setEvent(normalize('private-calendar', { id: 'private-event', start: { dateTime: new Date(job.dueAt).toISOString() } })!);
  f.hook(async () => { await f.store.revoke('private-owner', 'private-calendar', 'grant-2'); });
  assert.equal((await f.wake(job)).status, 204);
  f.sql.prepare('UPDATE calendars SET enabled = 1').run();
  assert.equal((await f.wake(job)).status, 204); // old grant cannot resurrect after re-enable
  assert.equal(f.sql.prepare('SELECT count(*) n FROM occurrence_outbox').get()!.n, 0);
});

test('Google recurrence discovery selects actual starts, exceptions and DST offsets, excluding all-day/cancelled instances', async () => {
  const responses = [
    { items: [{ id: 'series', recurrence: ['RRULE:FREQ=WEEKLY'], start: { dateTime: '2026-09-27T10:00:00+10:00' } }] },
    { items: [
      { id: 'current', recurringEventId: 'series', originalStartTime: { dateTime: '2026-10-04T10:00:00+11:00' }, start: { dateTime: '2026-10-04T10:00:00+11:00' }, end: { dateTime: '2026-10-04T11:00:00+11:00' } },
      { id: 'cancelled', status: 'cancelled', start: { dateTime: '2026-10-11T10:00:00+11:00' } },
      { id: 'all-day', start: { date: '2026-10-12' } },
      { id: 'exception', recurringEventId: 'series', originalStartTime: { dateTime: '2026-10-18T10:00:00+11:00' }, start: { dateTime: '2026-10-18T12:00:00+11:00' } },
    ] },
  ];
  const google = new GoogleCalendar('access', async () => Response.json(responses.shift()));
  const candidates = await google.alarmCandidates('cal', Date.parse('2026-10-04T10:30:00+11:00'));
  assert.equal(candidates.length, 1); assert.equal(candidates[0].providerEventId, 'exception');
  assert.equal(candidates[0].originalStartTime, '2026-10-18T10:00:00+11:00');
  const before = normalize('cal', { id: 'before', start: { dateTime: '2026-09-27T10:00:00+10:00' } })!;
  const after = normalize('cal', { id: 'after', start: { dateTime: '2026-10-04T10:00:00+11:00' } })!;
  assert.equal(Date.parse(after.start) - Date.parse(before.start), 7 * 86400_000 - 3600_000);
});
