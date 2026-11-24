export interface Statement {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface Database { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<unknown> }
export interface Environment {
  DB?: Database;
  OWNER_ID?: string;
  ADMIN_SECRET?: string;
  MCP_AUTH_TOKEN?: string;
  SESSION_SECRET?: string;
  TRUST_PROXY_AUTH_HEADER?: string;
  GOOGLE_WRITE_SCOPE_ENABLED?: string;
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
export type Calendar = { id: string; summary: string; accessRole: string; primary?: boolean };
export type CalendarAttendee = {
  email: string;
  displayName?: string;
  responseStatus?: 'needsAction' | 'declined' | 'tentative' | 'accepted';
  organizer?: boolean;
  self?: boolean;
};
export type CalendarEvent = {
  id: string; calendarId: string; title?: string; description?: string;
  start: string; end?: string; status: string; provider: string; providerEventId: string;
  organizerEmail?: string; organizerSelf?: boolean; creatorEmail?: string; attendees?: CalendarAttendee[];
  // Provider-owned stable identities. A recurrence identity need not be a date.
  seriesId?: string; recurrenceId?: string;
};
export type Watch = { id: string; token: string; resourceId: string; expiration: number };
export type CalendarChange = { watchId:string; token:string; resourceId:string; cursor:string; state:'initial'|'changed'|'removed' };
export type CalendarEventName = 'calendar.event.invited' | 'calendar.event.starting';
export type WriteBackAction =
  | { kind: 'rsvp'; agentEmail: string; responseStatus: 'accepted' | 'tentative' | 'declined' }
  | { kind: 'run_note'; agentEmail: string; runStatus: 'started' | 'completed' | 'failed'; note?: string };
export interface CalendarProvider {
  readonly providerId?: string;
  discoverCalendars(): Promise<Calendar[]>;
  watchCalendar(calendarId: string, id: string, token: string, address: string): Promise<Watch>;
  stopWatchingCalendar(id: string, resourceId: string): Promise<void>;
  syncEvents(calendarId: string, now: number): Promise<CalendarEvent[]>;
  alarmCandidates?(calendarId: string, now: number): Promise<CalendarEvent[]>;
  getOccurrence?(calendarId: string, eventId: string): Promise<CalendarEvent | null>;
  applyWriteBack?(calendarId: string, eventId: string, action: WriteBackAction,
    authorize?: (live: CalendarEvent) => Promise<void>): Promise<{ applied: true; kind: WriteBackAction['kind'] }>;
  nextOccurrence?(calendarId: string, seriesId: string, after: number): Promise<CalendarEvent | null>;
}
export class AppError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export class ProviderFailure extends AppError {
  readonly kind: 'transient' | 'authorization_lost' | 'permanent';
  readonly retryAfter?: string;
  constructor(kind: 'transient' | 'authorization_lost' | 'permanent', message = 'Calendar provider request failed.', retryAfter?: string | null) {
    super(kind === 'transient' ? 503 : kind === 'authorization_lost' ? 403 : 422, message);
    this.kind = kind;
    if (retryAfter && retryAfter.length <= 128 && !/[\x00-\x1f\x7f]/.test(retryAfter)) this.retryAfter = retryAfter;
  }
}
