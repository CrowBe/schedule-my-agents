'use client';
import { useCallback, useEffect, useState } from 'react';
import type { SetupCalendar, SetupStatus, SetupSnapshot, SetupClient } from '../lib/calendar/setup-contract';
import { CALENDAR_LOAD_ERROR } from '../lib/calendar/setup-contract';

const bridgeClient: SetupClient = {
  async load() {
    const response = await fetch('/api/status');
    const status = await response.json() as SetupStatus & { error?: string };
    if (!response.ok) throw new Error(status.error);
    let calendars: SetupCalendar[] = [], calendarError: string | undefined;
    if (status.connected) {
      try {
        const res = await fetch('/api/calendars');
        const result = await res.json() as { calendars: SetupCalendar[]; error?: string };
        if (!res.ok) throw new Error(result.error);
        calendars = result.calendars;
      } catch {
        calendarError = CALENDAR_LOAD_ERROR;
      }
    }
    return { status, calendars, siteUrl: location.origin, ...(calendarError ? { calendarError } : {}) };
  },
  async action(path, calendarId) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarId }),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) throw new Error(result.error);
  },
};

export default function Home({ client = bridgeClient, initialSnapshot }: { client?: SetupClient; initialSnapshot?: SetupSnapshot } = {}) {
  const [status, setStatus] = useState<SetupStatus | null>(initialSnapshot?.status ?? null);
  const [calendars, setCalendars] = useState<SetupCalendar[]>(initialSnapshot?.calendars ?? []);
  const [error, setError] = useState(initialSnapshot?.calendarError ?? '');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const data = await client.load();
    setStatus(data.status);
    setCalendars(data.calendars);
    setError(data.calendarError ?? '');
  }, [client]);

  useEffect(() => {
    if (!initialSnapshot) Promise.resolve().then(load).catch(e => setError(e.message));
  }, [load, initialSnapshot]);

  async function action(path: string, calendarId?: string) {
    setBusy(true);
    setError('');
    try {
      await client.action(path, calendarId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return <main>
    <header><span className="wordmark">Schedule my agents</span><span className="tag">Calendar bridge · MCP Events</span></header>
    <section className="intro"><p className="eyebrow">YOUR CALENDAR, YOUR CHOICE</p><h1>Choose the calendar<br/>your agents can see.</h1><p>Keep scheduling in your native calendar. Connect an account, then explicitly enable the calendars that may emit MCP Events.</p></section>
    {error && <div className="error" role="alert">{error} <button disabled={busy} onClick={() => { setError(''); load().catch(e => setError(e.message)); }}>Retry</button></div>}
    <div className="steps">
      <section className="panel"><div className="step">01 / CONNECTION</div><h2>Connect Google</h2><p>Connecting discovers calendars without enabling any of them.</p>
        {status?.connected ? <div className="connection"><span>Google connected</span><button disabled={busy} onClick={() => action('/api/google/disconnect')}>Disconnect</button></div> : <form method="post" action="/api/google/connect"><button className="primary" disabled={!status?.oauthReady || busy}>Connect Google</button></form>}
        {!status?.oauthReady && status && <p className="muted">Configure Google OAuth environment variables on this server to connect.</p>}
      </section>
      <section className="panel"><div className="step">02 / CALENDAR PERMISSION</div><h2>Enable a calendar</h2><p>Every calendar starts disabled. Newly shared calendars fail closed until you explicitly enable them.</p>
        {!status?.connected && <div className="empty">Your calendars will appear after you connect a calendar provider.</div>}
        {status?.connected && calendars.length === 0 && !error && <div className="empty">No accessible calendars found.</div>}
        <ul>{calendars.map(calendar => {
          const watch = status?.watches.find(w => w.calendar_id === calendar.id && w.status === 'active');
          const subscriptions = status?.subscriptions.find(s => s.calendar_id === calendar.id)?.count ?? 0;
          return <li key={calendar.id}><div className="calendar-main"><strong>{calendar.summary}</strong><span className="muted">{calendar.enabled ? 'Enabled by you' : 'Disabled'}</span></div><div className="controls"><button disabled={busy || calendar.accessRole === 'freeBusyReader'} onClick={() => action(calendar.enabled ? '/api/calendars/disable' : '/api/calendars/enable', calendar.id)}>{calendar.enabled ? 'Disable' : 'Enable'}</button>{calendar.enabled && <button disabled={busy || !status?.webhookVerified} onClick={() => action('/api/calendars/watch', calendar.id)}>{watch ? 'Renew watch' : 'Start watch'}</button>}{watch && <button disabled={busy || watch.expiration <= (status?.checkedAt ?? 0)} onClick={() => action('/api/calendars/resync', calendar.id)}>Resync now</button>}{subscriptions > 0 && <button disabled={busy} aria-label={`Stop event delivery for ${calendar.summary}`} onClick={() => action('/api/calendars/unsubscribe', calendar.id)}>Stop event delivery</button>}</div>{subscriptions > 0 && <p className="muted">{subscriptions} event subscription{subscriptions === 1 ? '' : 's'}. Stop delivery here to revoke them for this calendar.</p>}{watch && watch.sync_failed > 0 && <p role="alert">Last sync failed. Use Resync now to fetch the latest calendar state.</p>}{watch && <p className="watch">{watch.expiration <= (status?.checkedAt ?? 0) ? 'Watch expired' : 'Watch expires'} {new Date(watch.expiration).toLocaleString()}{watch.synced_at ? ` · Last sync ${new Date(watch.synced_at).toLocaleString()}` : ''}</p>}</li>;
        })}</ul>
      </section>
    </div>
    <aside><div className="step">BRIDGE STATUS</div><h2>{status?.alarmReady ? 'Calendar alarms are configured.' : 'Configure alarms to schedule occurrences.'}</h2><p>{status?.alarmReady ? `Resync an enabled calendar to register upcoming occurrences. ${status.dueWork} occurrence${status.dueWork === 1 ? '' : 's'} recorded as due work.` : 'Connect a calendar provider and start a watch to synchronize enabled calendars.'}</p><p>{status?.eventStartReady ? 'MCP Events delivery is enabled. Subscribe from any MCP Events-compatible agent host.' : 'Event discovery is closed until ingress, alarms, and delivery readiness are configured.'}</p><p className="muted">Timed events only, up to 366 days ahead. Calendar content never grants execution authority.</p></aside>
    <footer>Calendar titles and descriptions are untrusted data. Calendar permission never authorizes an agent to execute arbitrary instructions.</footer>
  </main>;
}
