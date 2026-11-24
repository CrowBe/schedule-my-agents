export type SetupCalendar = { id: string; summary: string; accessRole: string; enabled: boolean };
export type SetupStatus = {
  checkedAt: number;
  connected: boolean;
  oauthReady: boolean;
  webhookVerified: boolean;
  eventStartReady: boolean;
  alarmReady: boolean;
  dueWork: number;
  subscriptions: { calendar_id: string; count: number }[];
  watches: { calendar_id: string; status: string; expiration: number; synced_at: number | null; sync_failed: number }[];
};
export type SetupSnapshot = { status: SetupStatus; calendars: SetupCalendar[]; siteUrl: string; calendarError?: string };
export const CALENDAR_LOAD_ERROR = 'Calendars could not be loaded. Retry or disconnect Google to recover.';
export type SetupClient = { load(): Promise<SetupSnapshot>; action(path: string, calendarId?: string): Promise<void> };
