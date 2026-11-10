import { AppError, ProviderFailure, type Calendar, type CalendarEvent, type CalendarProvider, type Environment, type Watch, type CalendarChange } from './types.ts';
import { MAX_HORIZON } from '../../shared/alarm.ts';
import { boundedProbe } from '../../shared/probe-deadline.ts';
export const SCOPES = ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly'];
const ROOT = 'https://www.googleapis.com/calendar/v3';
export function readGoogleChange(request:Request):CalendarChange {
  const watchId=request.headers.get('x-goog-channel-id'),token=request.headers.get('x-goog-channel-token'),resourceId=request.headers.get('x-goog-resource-id');
  const state=request.headers.get('x-goog-resource-state'),cursor=request.headers.get('x-goog-message-number');
  if(!watchId||!token||!resourceId||!cursor||!/^\d{1,30}$/.test(cursor)||!['sync','exists','not_exists'].includes(state??'')) throw new AppError(400,'Invalid Google notification headers.');
  return {watchId,token,resourceId,cursor,state:state==='sync'?'initial':state==='not_exists'?'removed':'changed'};
}
export function newerGoogleChange(cursor:string,previous:string|null) { return !previous || BigInt(cursor)>BigInt(previous); }
async function googleFailure(response:Response,signal:AbortSignal,authorization=false):Promise<ProviderFailure> {
  let reasons:string[]=[];
  const reader=response.body?.getReader();
  try {
    if(reader) {
      const decoder=new TextDecoder();let text='',size=0;
      for(;;) {const part=await boundedProbe(reader.read(),signal);if(part.done) break;size+=part.value.byteLength;if(size>4096) break;text+=decoder.decode(part.value,{stream:true});}
      if(size<=4096) {
        const data=JSON.parse(text+decoder.decode()) as {error?:string|{errors?:{reason?:string}[]}};
        reasons=typeof data.error==='string'?[data.error]:(data.error?.errors??[]).map(e=>e.reason??'');
      }
    }
  } catch { /* Classification uses fixed statuses when the bounded error body is unavailable. */ }
  finally {void reader?.cancel().catch(()=>{});}
  const limited=reasons.some(reason=>['rateLimitExceeded','userRateLimitExceeded','quotaExceeded'].includes(reason));
  if(limited || [408,429].includes(response.status) || response.status>=500) return new ProviderFailure('transient','Calendar provider is temporarily unavailable.',response.headers.get('Retry-After'));
  if(reasons.includes('invalid_grant') || [401,403,404].includes(response.status) || (authorization && response.status===400)) return new ProviderFailure('authorization_lost','Google access is unavailable. Reconnect Google if authorization was revoked.');
  return new ProviderFailure('permanent','Calendar provider rejected this request.');
}
export type Fetch = typeof fetch;
type GoogleEvent = { id: string; summary?: string; description?: string; status?: string; recurrence?: string[]; recurringEventId?: string; originalStartTime?: {dateTime?: string}; start?: {dateTime?: string; date?: string}; end?: {dateTime?: string; date?: string} };
export function normalize(calendarId: string, item: GoogleEvent): CalendarEvent | null {
  // All-day events do not imply an execution time. Google expands recurrence.
  if (item.status === 'cancelled' || !item.start?.dateTime || !Number.isFinite(Date.parse(item.start.dateTime))) return null;
  return { id: `${calendarId}:${item.id}`, calendarId, provider: 'google', providerEventId: item.id,
    title: item.summary?.slice(0, 512), description: item.description?.slice(0, 8192),
    start: item.start.dateTime, end: item.end?.dateTime, status: item.status ?? 'confirmed',
    ...(item.recurringEventId ? { seriesId: item.recurringEventId, recurrenceId: item.originalStartTime?.dateTime && Number.isFinite(Date.parse(item.originalStartTime.dateTime))
      ? new Date(item.originalStartTime.dateTime).toISOString().replace('.000Z','Z') : undefined } : {}) };
}
export async function tokenRequest(env: Environment, values: Record<string, string>, http: Fetch) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new AppError(503, 'Google OAuth is not configured.');
  // Workers supports manual/follow redirects. Never follow credential-bearing requests.
  const signal=AbortSignal.timeout(10_000);
  let response:Response;
  try {response = await http('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'manual', signal,
    body: new URLSearchParams({ ...values, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET }) });}
  catch {throw new ProviderFailure('transient','Calendar authorization is temporarily unavailable.');}
  if (!response.ok) throw await googleFailure(response,signal,true);
  const tokens = await response.json() as { access_token?: string; refresh_token?: string; scope?: string };
  if (!tokens.access_token) throw new AppError(502, 'Google did not return an access token.');
  return tokens;
}
export class GoogleCalendar implements CalendarProvider {
  readonly providerId = 'google';
  #accessToken: string;
  #refreshAccess?:()=>Promise<string>;
  private http: Fetch;
  constructor(accessToken: string, http: Fetch, refreshAccess?:()=>Promise<string>) {
    this.#accessToken = accessToken;
    this.#refreshAccess = refreshAccess;
    // Call native fetch as a function, without making this adapter its receiver.
    this.http = (input, init) => http(input, init);
  }
  private async call(path: string, init: RequestInit = {}, missingIsNull = false, refreshAllowed=true):Promise<unknown> {
    const signal=AbortSignal.timeout(10_000);
    let response:Response;
    try {response = await this.http(`${ROOT}${path}`, { ...init, redirect: 'manual', signal,
      headers: { Authorization: `Bearer ${this.#accessToken}`, 'Content-Type': 'application/json' } });}
    catch {throw new ProviderFailure('transient','Calendar provider is temporarily unavailable.');}
    if(response.status===401 && this.#refreshAccess && refreshAllowed) {
      void response.body?.cancel().catch(()=>{});this.#accessToken=await this.#refreshAccess();
      return this.call(path,init,missingIsNull,false);
    }
    if (missingIsNull && [404, 410].includes(response.status)) {void response.body?.cancel().catch(()=>{});return null;}
    if (!response.ok) throw await googleFailure(response,signal);
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
  async getOccurrence(calendarId: string, eventId: string) {
    const item = await this.call(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {}, true) as GoogleEvent | null;
    return item ? normalize(calendarId, item) : null;
  }
  private async listed(path: string, params: URLSearchParams) {
    const results: GoogleEvent[] = [];
    for (let page = 0; page < 10; page++) {
      const data = await this.call(`${path}?${params}`) as { items?: GoogleEvent[]; nextPageToken?: string };
      results.push(...data.items ?? []);
      if (!data.nextPageToken) return results;
      params.set('pageToken', data.nextPageToken);
    }
    throw new AppError(422, 'Alarm discovery exceeds the bounded provider page limit.');
  }
  async nextOccurrence(calendarId: string, seriesId: string, after: number) {
    // timeMin filters END time, not start; filter/sort actual starts ourselves.
    const params = new URLSearchParams({ timeMin: new Date(after).toISOString(), timeMax: new Date(after + MAX_HORIZON).toISOString(), showDeleted: 'false', maxResults: '2500' });
    const items = await this.listed(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(seriesId)}/instances`, params);
    return items.map(i => normalize(calendarId, i)).filter((e): e is CalendarEvent => Boolean(e && Date.parse(e.start) > after))
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0] ?? null;
  }
  async alarmCandidates(calendarId: string, now: number) {
    // Retrieve series masters, then let Google expand only enough to select the next instance.
    const params = new URLSearchParams({ singleEvents: 'false', showDeleted: 'false', maxResults: '2500',
      timeMin: new Date(now).toISOString(), timeMax: new Date(now + MAX_HORIZON).toISOString() });
    const items = await this.listed(`/calendars/${encodeURIComponent(calendarId)}/events`, params);
    const series = new Set<string>(); const singles: CalendarEvent[] = [];
    for (const item of items) {
      if (item.recurrence) series.add(item.id);
      else if (item.recurringEventId) series.add(item.recurringEventId);
      else { const event = normalize(calendarId, item); if (event && Date.parse(event.start) > now) singles.push(event); }
    }
    if (series.size + singles.length > 500) throw new AppError(422, 'Alarm scheduling is limited to 500 upcoming events or series per calendar.');
    for (const id of series) { const next = await this.nextOccurrence(calendarId, id, now); if (next) singles.push(next); }
    return singles;
  }
}
