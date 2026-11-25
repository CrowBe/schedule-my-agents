export type SetupCalendar = { id: string; summary: string; accessRole: string; enabled: boolean; writeBackEnabled?: boolean };
export type SetupAgentAlias = { email: string; label: string; created_at: number };
export type SetupAllowlistEntry = { email: string; created_at: number };
export type SetupInvitation = {
  id: string; calendar_id: string; agent_email: string; organizer_email: string | null; external_invite: number;
  approval_status: string; event_title: string | null; event_start: string | null; updated_at: number;
};
export type SetupSession = { authenticated: boolean; mode: 'self_hosted' | 'proxy' | 'unconfigured'; owner?: string };
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
  agentAliases?: SetupAgentAlias[];
  allowlist?: SetupAllowlistEntry[];
  invitations?: SetupInvitation[];
};
export type SetupSnapshot = { status: SetupStatus; calendars: SetupCalendar[]; siteUrl: string; calendarError?: string };
export const CALENDAR_LOAD_ERROR = 'Calendars could not be loaded. Retry or disconnect Google to recover.';
export type SetupClient = {
  session?(): Promise<SetupSession>;
  login?(secret: string): Promise<void>;
  logout?(): Promise<void>;
  load(): Promise<SetupSnapshot>;
  /** A string body is a calendar ID, sent as `{ calendarId }`. */
  action(path: string, body?: Record<string, unknown> | string): Promise<unknown>;
};
