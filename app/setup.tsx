'use client';
import { useCallback, useEffect, useState } from 'react';
type Calendar = { id: string; summary: string; accessRole: string; enabled: boolean };
type Status = { checkedAt: number; connected: boolean; oauthReady: boolean; webhookVerified: boolean; eventStartReady: boolean; watches: { calendar_id: string; status: string; expiration: number; synced_at: number | null; sync_failed: number }[] };
export default function Home() {
  const [status, setStatus] = useState<Status | null>(null);
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const response = await fetch('/api/status'); const data = await response.json() as Status & { error?: string };
    if (!response.ok) throw new Error(data.error); setStatus(data);
    if (data.connected) {
      const response = await fetch('/api/calendars'); const result = await response.json() as { calendars: Calendar[]; error?: string };
      if (!response.ok) throw new Error(result.error); setCalendars(result.calendars);
    } else setCalendars([]);
  }, []);
  useEffect(() => { Promise.resolve().then(load).catch(e => setError(e.message)); }, [load]);
  async function action(path: string, calendarId?: string) {
    setBusy(true); setError('');
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ calendarId }) });
      const result = await response.json() as { error?: string }; if (!response.ok) throw new Error(result.error);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Please try again.'); } finally { setBusy(false); }
  }
  return <main>
    <header><span className="wordmark">Schedule my agents</span><span className="tag">Calendar bridge · First slice</span></header>
    <section className="intro"><p className="eyebrow">YOUR CALENDAR, YOUR CHOICE</p><h1>Choose the calendar<br/>your agent can see.</h1><p>Keep scheduling in Google Calendar. Connect your account, then explicitly enable the calendars you want to share.</p></section>
    {error && <div className="error" role="alert">{error} <button disabled={busy} onClick={() => { setError(''); load().catch(e => setError(e.message)); }}>Retry</button></div>}
    <div className="steps">
      <section className="panel"><div className="step">01 / CONNECTION</div><h2>Connect Google</h2><p>Read-only calendar access. Connecting does not enable any calendar.</p>
        {status?.connected ? <div className="connection"><span>Google connected</span><button disabled={busy} onClick={() => action('/api/google/disconnect')}>Disconnect</button></div> : <form method="post" action="/api/google/connect"><button className="primary" disabled={!status?.oauthReady || busy}>Connect Google</button></form>}
        {!status?.oauthReady && status && <p className="muted">Google authorization is awaiting configuration by the Site owner.</p>}
      </section>
      <section className="panel"><div className="step">02 / CALENDAR PERMISSION</div><h2>Enable a calendar</h2><p>Every calendar starts disabled. Newly shared calendars stay disabled until you choose them.</p>
        {!status?.connected && <div className="empty">Your calendars will appear after you connect Google.</div>}
        {status?.connected && calendars.length === 0 && <div className="empty">No accessible calendars found.</div>}
        <ul>{calendars.map(calendar => {
          const watch = status?.watches.find(w => w.calendar_id === calendar.id && w.status === 'active');
          return <li key={calendar.id}><div className="calendar-main"><strong>{calendar.summary}</strong><span className="muted">{calendar.enabled ? 'Enabled by you' : 'Disabled'}</span></div><div className="controls"><button disabled={busy || calendar.accessRole === 'freeBusyReader'} onClick={() => action(calendar.enabled ? '/api/calendars/disable' : '/api/calendars/enable', calendar.id)}>{calendar.enabled ? 'Disable' : 'Enable'}</button>{calendar.enabled && <button disabled={busy || !status?.webhookVerified} onClick={() => action('/api/calendars/watch', calendar.id)}>{watch ? 'Renew watch' : 'Start watch'}</button>}{watch && <button disabled={busy || watch.expiration <= (status?.checkedAt ?? 0)} onClick={() => action('/api/calendars/resync', calendar.id)}>Resync now</button>}</div>{watch && watch.sync_failed > 0 && <p role="alert">Last sync failed. Use Resync now to fetch the latest calendar state.</p>}{watch && <p className="watch">{watch.expiration <= (status?.checkedAt ?? 0) ? 'Watch expired' : 'Watch expires'} {new Date(watch.expiration).toLocaleString()}{watch.synced_at ? ` · Last sync ${new Date(watch.synced_at).toLocaleString()}` : ''}</p>}</li>;
        })}</ul>
      </section>
    </div>
    <aside><div className="step">DEMO STATUS</div><h2>Calendar setup is the first checkpoint.</h2><p>This version saves your calendar permission and contains the Google watch and notification receiver. Watch creation becomes available after the hosted notification route is verified.</p><p>Scheduled agent actions are not active yet. Reliable event-start delivery and ChatGPT event subscriptions remain the next checkpoint.</p></aside>
    <footer>Calendar titles and descriptions are untrusted data. Calendar permission never authorizes an agent to execute their contents.</footer>
  </main>;
}
