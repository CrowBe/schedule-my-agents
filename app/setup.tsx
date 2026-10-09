'use client';
import { useCallback, useEffect, useState } from 'react';
import type { SetupCalendar, SetupStatus, SetupSnapshot, SetupClient } from '../lib/calendar/setup-contract';
import { CALENDAR_LOAD_ERROR } from '../lib/calendar/setup-contract';
const siteClient: SetupClient = {
  async load() {
    const response = await fetch('/api/status'); const status = await response.json() as SetupStatus & { error?: string };
    if (!response.ok) throw new Error(status.error);
    let calendars: SetupCalendar[] = [], calendarError: string | undefined;
    if (status.connected) {
      try {
        const response = await fetch('/api/calendars'); const result = await response.json() as { calendars: SetupCalendar[]; error?: string };
        if (!response.ok) throw new Error(result.error); calendars = result.calendars;
      } catch { calendarError = CALENDAR_LOAD_ERROR; }
    }
    return { status, calendars, siteUrl: location.origin, ...(calendarError ? {calendarError} : {}) };
  },
  async action(path, calendarId) {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ calendarId }) });
    const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error);
  },
};
export default function Home({ client = siteClient, initialSnapshot, embedded = false }: { client?: SetupClient; initialSnapshot?: SetupSnapshot; embedded?: boolean } = {}) {
  const [status, setStatus] = useState<SetupStatus | null>(initialSnapshot?.status ?? null);
  const [calendars, setCalendars] = useState<SetupCalendar[]>(initialSnapshot?.calendars ?? []);
  const [error, setError] = useState(initialSnapshot?.calendarError ?? ''); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const data = await client.load(); setStatus(data.status); setCalendars(data.calendars); setError(data.calendarError ?? '');
  }, [client]);
  useEffect(() => { if (!initialSnapshot) Promise.resolve().then(load).catch(e => setError(e.message)); }, [load, initialSnapshot]);
  async function action(path: string, calendarId?: string) {
    setBusy(true); setError('');
    try {
      await client.action(path, calendarId);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Please try again.'); } finally { setBusy(false); }
  }
  return <main className={embedded ? 'embedded' : undefined}>
    <header><span className="wordmark">Schedule my agents</span><span className="tag">Calendar bridge · Bounded demo</span></header>
    <section className="intro"><p className="eyebrow">YOUR CALENDAR, YOUR CHOICE</p><h1>Choose the calendar<br/>your agent can see.</h1><p>Keep scheduling in Google Calendar. Connect your account, then explicitly enable the calendars you want to share.</p></section>
    {embedded && <div className="refresh"><button disabled={busy} onClick={() => { setError(''); load().catch(e => setError(e.message)); }}>Refresh connection</button><p className="muted">After connecting Google in the browser, refresh here. Opening this view does not change your permissions.</p></div>}
    {error && <div className="error" role="alert">{error} <button disabled={busy} onClick={() => { setError(''); load().catch(e => setError(e.message)); }}>Retry</button></div>}
    <div className="steps">
      <section className="panel"><div className="step">01 / CONNECTION</div><h2>Connect Google</h2><p>Read-only calendar access. Connecting does not enable any calendar.</p>
        {status?.connected ? <div className="connection"><span>Google connected</span><button disabled={busy} onClick={() => action('/api/google/disconnect')}>Disconnect</button></div> : client.connect ? <button className="primary" disabled={!status?.oauthReady || busy} onClick={() => client.connect!().catch(e => setError(e.message))}>Connect Google</button> : <form method="post" action="/api/google/connect"><button className="primary" disabled={!status?.oauthReady || busy}>Connect Google</button></form>}
        {!status?.oauthReady && status && <p className="muted">Google authorization is awaiting configuration by the Site owner.</p>}
      </section>
      <section className="panel"><div className="step">02 / CALENDAR PERMISSION</div><h2>Enable a calendar</h2><p>Every calendar starts disabled. Newly shared calendars stay disabled until you choose them.</p>
        <p className="muted">Renew watches manually before the expiry shown below. If a calendar change is missed, use Resync now; renew an expired watch first.</p>
        {!status?.connected && <div className="empty">Your calendars will appear after you connect Google.</div>}
        {status?.connected && calendars.length === 0 && !error && <div className="empty">No accessible calendars found.</div>}
        <ul>{calendars.map(calendar => {
          const watch = status?.watches.find(w => w.calendar_id === calendar.id && w.status === 'active');
          const subscriptions = status?.subscriptions.find(s => s.calendar_id === calendar.id)?.count ?? 0;
          return <li key={calendar.id}><div className="calendar-main"><strong>{calendar.summary}</strong><span className="muted">{calendar.enabled ? 'Enabled by you' : 'Disabled'}</span></div><div className="controls"><button disabled={busy || calendar.accessRole === 'freeBusyReader'} onClick={() => action(calendar.enabled ? '/api/calendars/disable' : '/api/calendars/enable', calendar.id)}>{calendar.enabled ? 'Disable' : 'Enable'}</button>{calendar.enabled && <button disabled={busy || !status?.webhookVerified} onClick={() => action('/api/calendars/watch', calendar.id)}>{watch ? 'Renew watch' : 'Start watch'}</button>}{watch && <button disabled={busy || watch.expiration <= (status?.checkedAt ?? 0)} onClick={() => action('/api/calendars/resync', calendar.id)}>Resync now</button>}{subscriptions > 0 && <button disabled={busy} aria-label={`Stop event delivery for ${calendar.summary}`} onClick={() => action('/api/calendars/unsubscribe', calendar.id)}>Stop event delivery</button>}</div>{subscriptions > 0 && <p className="muted">{subscriptions} event subscription{subscriptions === 1 ? '' : 's'}. Stop delivery here to revoke them for this calendar.</p>}{watch && watch.sync_failed > 0 && <p role="alert">Last sync failed. Use Resync now to fetch the latest calendar state.</p>}{watch && <p className="watch">{watch.expiration <= (status?.checkedAt ?? 0) ? 'Watch expired' : 'Watch expires'} {new Date(watch.expiration).toLocaleString()}{watch.synced_at ? ` · Last sync ${new Date(watch.synced_at).toLocaleString()}` : ''}</p>}</li>;
        })}</ul>
      </section>
    </div>
    <aside><div className="step">DEMO STATUS</div><h2>{status?.alarmReady ? 'Calendar alarms are configured.' : 'Calendar setup is the first checkpoint.'}</h2><p>{status?.alarmReady ? `Resync an enabled calendar to schedule its upcoming events. ${status.dueWork} occurrence${status.dueWork === 1 ? '' : 's'} recorded as due work.` : 'Connect Google and start a watch to keep enabled calendars synchronized.'}</p><p>{status?.eventStartReady ? 'Calendar event delivery is available. Subscribe through the existing plugin in a ChatGPT Work Cloud chat. Callback receipt and the chat’s response are separate checks.' : 'Event discovery is closed while delivery readiness is being verified.'}</p><p className="muted">Timed events only, up to 366 days ahead. Give the chat separate instructions for its response. Pause monitoring in the chat, then use Stop event delivery here to revoke any remaining subscriptions.</p></aside>
    <footer>Calendar titles and descriptions are untrusted data. Calendar permission never authorizes an agent to execute their contents.</footer>
  </main>;
}
