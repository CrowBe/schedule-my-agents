import { AppError, type Calendar, type CalendarEvent, type CalendarProvider, type Environment, type Watch } from './types.ts';
export const SCOPES = ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly'];
const ROOT = 'https://www.googleapis.com/calendar/v3';
export type Fetch = typeof fetch;
type GoogleEvent = { id: string; summary?: string; description?: string; status?: string; start?: {dateTime?: string; date?: string}; end?: {dateTime?: string; date?: string} };
export function normalize(calendarId: string, item: GoogleEvent): CalendarEvent | null {
  // All-day events do not imply an execution time. Google expands recurrence.
  if (item.status === 'cancelled' || !item.start?.dateTime || !Number.isFinite(Date.parse(item.start.dateTime))) return null;
  return { id: `${calendarId}:${item.id}`, calendarId, provider: 'google', providerEventId: item.id,
    title: item.summary?.slice(0, 512), description: item.description?.slice(0, 8192),
    start: item.start.dateTime, end: item.end?.dateTime, status: item.status ?? 'confirmed' };
}
export async function tokenRequest(env: Environment, values: Record<string, string>, http: Fetch) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new AppError(503, 'Google OAuth is not configured.');
  const response = await http('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({ ...values, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET }) });
  if (!response.ok) throw new AppError(502, 'Google authorization failed. Reconnect Google if access was revoked.');
  const tokens = await response.json() as { access_token?: string; refresh_token?: string; scope?: string };
  if (!tokens.access_token) throw new AppError(502, 'Google did not return an access token.');
  return tokens;
}
export class GoogleCalendar implements CalendarProvider {
  constructor(private accessToken: string, private http: Fetch) {}
  private async call(path: string, init: RequestInit = {}) {
    const response = await this.http(`${ROOT}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' } });
    if (!response.ok) throw new AppError(response.status === 403 || response.status === 404 ? 403 : 502, 'Google Calendar request failed. Check calendar access and reconnect if needed.');
    return response.status === 204 ? {} : response.json();
  }
  async discoverCalendars(): Promise<Calendar[]> {
    const results: Calendar[] = []; let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const params = new URLSearchParams({ maxResults: '250', ...(pageToken ? { pageToken } : {}) });
      const data = await this.call(`/users/me/calendarList?${params}`) as { items?: Calendar[]; nextPageToken?: string };
      results.push(...(data.items ?? []).map(c => ({ id: c.id, summary: c.summary ?? c.id, accessRole: c.accessRole })));
      pageToken = data.nextPageToken; if (!pageToken) return results;
    }
    throw new AppError(422, 'Calendar discovery exceeds the proof-of-concept limit.');
  }
  async watchCalendar(calendarId: string, id: string, token: string, address: string): Promise<Watch> {
    const data = await this.call(`/calendars/${encodeURIComponent(calendarId)}/events/watch`, { method: 'POST', body: JSON.stringify({ id, token, type: 'web_hook', address }) }) as {id: string; resourceId: string; expiration: string};
    if (data.id !== id || !data.resourceId || !Number.isFinite(Number(data.expiration))) throw new AppError(502, 'Google returned an invalid watch.');
    return { id, token, resourceId: data.resourceId, expiration: Number(data.expiration) };
  }
  async stopWatchingCalendar(id: string, resourceId: string) {
    await this.call('/channels/stop', { method: 'POST', body: JSON.stringify({ id, resourceId }) });
  }
  async syncEvents(calendarId: string, now: number) {
    const results: CalendarEvent[] = []; let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const params = new URLSearchParams({ singleEvents: 'true', showDeleted: 'false', maxResults: '250',
        timeMin: new Date(now).toISOString(), timeMax: new Date(now + 7 * 86400_000).toISOString(), ...(pageToken ? { pageToken } : {}) });
      const data = await this.call(`/calendars/${encodeURIComponent(calendarId)}/events?${params}`) as { items?: GoogleEvent[]; nextPageToken?: string };
      for (const item of data.items ?? []) { const event = normalize(calendarId, item); if (event && Date.parse(event.start) >= now) results.push(event); }
      pageToken = data.nextPageToken; if (!pageToken) return results;
    }
    throw new AppError(422, 'Upcoming events exceed the proof-of-concept limit.');
  }
}
