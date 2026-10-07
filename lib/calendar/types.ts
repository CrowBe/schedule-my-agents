export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface Database { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<unknown> }
export interface Environment {
  DB?: Database;
  // Explicitly enable discovery after migration, including an authorized live test.
  MCP_EVENTS_READY?: string;
  SITE_ORIGIN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  // Set only after an unauthenticated provider POST reaches application validation in production.
  GOOGLE_WEBHOOK_VERIFIED?: string;
  DISPATCHER_ORIGIN?: string;
  ALARM_ENCRYPTION_KEY?: string;
  ALARM_REGISTRATION_KEY?: string;
  ALARM_CALLBACK_KEY?: string;
}
export type Calendar = { id: string; summary: string; accessRole: string };
export type CalendarEvent = {
  id: string; calendarId: string; title?: string; description?: string;
  start: string; end?: string; status: string; provider: 'google'; providerEventId: string;
  recurringEventId?: string; originalStartTime?: string;
};
export type Watch = { id: string; token: string; resourceId: string; expiration: number };
export interface CalendarProvider {
  discoverCalendars(): Promise<Calendar[]>;
  watchCalendar(calendarId: string, id: string, token: string, address: string): Promise<Watch>;
  stopWatchingCalendar(id: string, resourceId: string): Promise<void>;
  syncEvents(calendarId: string, now: number): Promise<CalendarEvent[]>;
  alarmCandidates?(calendarId: string, now: number): Promise<CalendarEvent[]>;
  getOccurrence?(calendarId: string, eventId: string): Promise<CalendarEvent | null>;
  nextOccurrence?(calendarId: string, seriesId: string, after: number): Promise<CalendarEvent | null>;
}
export class AppError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
