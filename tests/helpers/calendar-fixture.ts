import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { Store } from '../../lib/calendar/store.ts';
import { CalendarService } from '../../lib/calendar/service.ts';
import { OccurrenceAlarms } from '../../lib/calendar/alarms.ts';
import { GoogleCalendar } from '../../lib/calendar/google.ts';
import type { CallbackTransport } from '../../lib/calendar/subscriptions.ts';
import { signedHeaders, CALLBACK_PATH, type AlarmJob } from '../../shared/alarm.ts';
import type { CalendarEvent, CalendarProvider, Environment, Statement } from '../../lib/calendar/types.ts';

export function calendarFixture(kind: 'google' | 'opaque') {
 const sql = new DatabaseSync(':memory:');
 for (const file of readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort()) sql.exec(readFileSync(`drizzle/${file}`, 'utf8'));
 class Prepared implements Statement {
  values: SQLInputValue[] = [];
  constructor(private query: string) {}
  bind(...v: unknown[]) { this.values = v as SQLInputValue[]; return this; }
  async first<T>() { return (sql.prepare(this.query).get(...this.values) ?? null) as T | null; }
  async all<T>() { return { results: sql.prepare(this.query).all(...this.values) as T[] }; }
  async run() { return sql.prepare(this.query).run(...this.values); }
 }
 const DB = { prepare: (query: string) => new Prepared(query), async batch(statements: Statement[]) {
  sql.exec('BEGIN'); try { for (const statement of statements) await statement.run(); sql.exec('COMMIT'); }
  catch (error) { sql.exec('ROLLBACK'); throw error; }
 } };
 let now = Date.parse('2026-10-13T02:00:00Z');
 const env: Environment = { DB, SITE_ORIGIN: 'https://site.example', DISPATCHER_ORIGIN: 'https://alarm.example',
  TOKEN_ENCRYPTION_KEY: btoa('t'.repeat(32)), ALARM_ENCRYPTION_KEY: btoa('e'.repeat(32)), ALARM_CALLBACK_KEY: btoa('c'.repeat(32)), ALARM_REGISTRATION_KEY: btoa('r'.repeat(32)) };
 sql.prepare('INSERT INTO connections (owner,refresh_token,created_at,provider_id,connection_id) VALUES (?,?,?,?,?)').run('owner', 'encrypted', now, kind, `connection-${kind}`);
 sql.prepare('INSERT INTO calendars VALUES (?,?,?,1,?)').run('owner', 'calendar', 'Test', 'grant');
 // The second source uses opaque slots, not Google's date-based recurrence identity.
 let source = { uid: 'instance-A', chain: 'series', slot: kind === 'google' ? '2026-10-13T02:01:00Z' : 'opaque-slot-A',
  when: '2026-10-13T02:01:00Z', title: 'Untrusted title', cancelled: false };
 let following: typeof source | null = { ...source, uid: 'instance-B', slot: kind === 'google' ? '2026-10-20T02:01:00Z' : 'opaque-slot-B', when: '2026-10-20T02:01:00Z' };
 let lookup: () => Promise<void> = async () => {};
 const raw = (item: typeof source) => ({ id: item.uid, recurringEventId: item.chain, originalStartTime: { dateTime: item.slot }, summary: item.title,
  status: item.cancelled ? 'cancelled' : 'confirmed', start: { dateTime: item.when } });
 const canonical = (item: typeof source): CalendarEvent | null => item.cancelled ? null : {
  id: item.uid, calendarId: 'calendar', provider: 'opaque', providerEventId: item.uid, seriesId: item.chain, recurrenceId: item.slot,
  start: item.when, status: 'confirmed', title: item.title,
 };
 const opaque: CalendarProvider = { discoverCalendars: async () => [], watchCalendar: async () => { throw new Error('not used'); }, stopWatchingCalendar: async () => {},
  syncEvents: async () => source.cancelled ? [] : [canonical(source)!], alarmCandidates: async () => source.cancelled ? [] : [canonical(source)!],
  getOccurrence: async (_calendar, id) => { await lookup(); return id === source.uid ? canonical(source) : null; },
  nextOccurrence: async () => following ? canonical(following) : null };
 const google = new GoogleCalendar('test-access', async input => {
  const path = new URL(String(input)).pathname;
  if (path.endsWith('/instances')) return Response.json({ items: [source, ...(following ? [following] : [])].map(raw) });
  if (path.endsWith('/events')) return Response.json({ items: [{ id: source.chain, recurrence: ['RRULE:FREQ=WEEKLY'] }] });
  await lookup(); return Response.json(raw(source));
 });
 const provider = kind === 'google' ? google : opaque, store = new Store(DB), jobs: AlarmJob[] = [];
 const http: typeof fetch = async (_url, init) => { const job = JSON.parse(String(init?.body)); jobs.push(job); return Response.json({ registered: true, id: job.id }); };
 const alarms = () => new OccurrenceAlarms(env, store, http, () => now, async () => provider);
 const service = (callbackTransport?: CallbackTransport) => new CalendarService(env, { http, now: () => now, provider: async () => provider, callbackTransport });
 return { sql, DB, env, store, jobs, provider, alarms, service, now: () => now, setNow: (value: number) => { now = value; },
  edit: (value: Partial<typeof source>) => { source = { ...source, ...value }; }, setNext: (value: typeof following) => { following = value; },
  lookup: (hook: typeof lookup) => { lookup = hook; },
  async seed() { await alarms().seed('owner', 'calendar', 'grant', provider); return jobs.at(-1)!; },
  async wake(job: AlarmJob, callbackTransport?: CallbackTransport) { const body = JSON.stringify(job); return service(callbackTransport).handle(new Request(env.SITE_ORIGIN + CALLBACK_PATH,
   { method: 'POST', body, headers: await signedHeaders(env.ALARM_CALLBACK_KEY!, CALLBACK_PATH, body, now) })); },
 };
}
