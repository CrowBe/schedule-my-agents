'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { SetupCalendar, SetupStatus, SetupSnapshot, SetupClient, SetupSession, SetupInvitation } from '../lib/calendar/setup-contract';
import { CALENDAR_LOAD_ERROR } from '../lib/calendar/setup-contract';

async function post(path: string, body: unknown) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error);
}

const bridgeClient: SetupClient = {
  async session() {
    const response = await fetch('/api/auth/session');
    if (!response.ok) throw new Error('Sign-in status could not be checked.');
    return await response.json() as SetupSession;
  },
  login: secret => post('/api/auth/login', { secret }),
  logout: () => post('/api/auth/logout', {}),
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
  action: (path, body) => post(path, typeof body === 'string' ? { calendarId: body } : body ?? {}),
};

const message = (e: unknown) => e instanceof Error && e.message ? e.message : 'Please try again.';
const formatTime = (value: number | string) => new Date(value).toLocaleString();

export default function Home({ client = bridgeClient, initialSnapshot, initialSession }: { client?: SetupClient; initialSnapshot?: SetupSnapshot; initialSession?: SetupSession } = {}) {
  const [session, setSession] = useState<SetupSession | null>(initialSession ?? null);
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

  const start = useCallback(async () => {
    const current = client.session ? await client.session() : null;
    setSession(current);
    if (!current || current.authenticated) await load();
  }, [client, load]);

  useEffect(() => {
    if (!initialSnapshot && !initialSession) Promise.resolve().then(start).catch(e => setError(message(e)));
  }, [start, initialSnapshot, initialSession]);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await task(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  const action = (path: string, body?: Record<string, unknown> | string) => run(async () => { await client.action(path, body); await load(); });
  function submit(path: string, fields: string[]) {
    return (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = event.currentTarget, data = new FormData(form);
      run(async () => {
        await client.action(path, Object.fromEntries(fields.map(field => [field, String(data.get(field) ?? '').trim()])));
        form.reset();
        await load();
      });
    };
  }
  function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget, secret = String(new FormData(form).get('secret') ?? '');
    run(async () => { await client.login!(secret); form.reset(); await start(); });
  }
  const logout = () => run(async () => {
    await client.logout!();
    setStatus(null);
    setCalendars([]);
    setSession({ authenticated: false, mode: 'self_hosted' });
  });

  const signedOut = session !== null && !session.authenticated;
  const header = <header>
    <span className="wordmark">Schedule my agents</span>
    <span className="header-end"><span className="tag">Calendar bridge · MCP Events</span>
      {session?.authenticated && session.mode === 'self_hosted' && client.logout && <button data-testid="logout-button" disabled={busy} onClick={logout}>Sign out</button>}</span>
  </header>;
  const errorBanner = error && <div className="error" role="alert">{error} {!signedOut && <button disabled={busy} onClick={() => { setError(''); start().catch(e => setError(message(e))); }}>Retry</button>}</div>;

  if (signedOut) return <main>
    {header}
    <section className="intro"><p className="eyebrow">SINGLE-USER BRIDGE</p><h1>Sign in to manage<br/>your calendar bridge.</h1></section>
    {errorBanner}
    {session.mode === 'self_hosted' && <section className="panel narrow" aria-labelledby="sign-in-title">
      <h2 id="sign-in-title">Admin sign-in</h2>
      <p>Enter the <code>ADMIN_SECRET</code> configured on this server. The session lasts 24 hours on this browser.</p>
      <form className="stack" onSubmit={login}>
        <label htmlFor="admin-secret">Admin secret</label>
        <input id="admin-secret" name="secret" type="password" autoComplete="current-password" required data-testid="admin-secret-input" />
        <button className="primary" type="submit" disabled={busy} data-testid="login-submit">Sign in</button>
      </form>
    </section>}
    {session.mode === 'unconfigured' && <section className="panel narrow" data-testid="auth-unconfigured">
      <h2>Finish self-hosted setup</h2>
      <p>This server refuses every setup and MCP request until authentication is configured. Set these secrets on your deployment, then reload:</p>
      <ul className="config">
        <li><code>ADMIN_SECRET</code><span className="muted">Signs you in to this setup page. Generate one with <code>openssl rand -base64 32</code>.</span></li>
        <li><code>MCP_AUTH_TOKEN</code><span className="muted">A different bearer token for your MCP Events agent host. It cannot change setup.</span></li>
      </ul>
      <p className="muted">Behind an authenticating reverse proxy that strips caller-supplied <code>x-authenticated-owner</code>, you may set <code>TRUST_PROXY_AUTH_HEADER=true</code> instead.</p>
    </section>}
    {session.mode === 'proxy' && <section className="panel narrow"><h2>Not signed in</h2><p>Your authenticating reverse proxy did not identify you. Sign in through the proxy and reload.</p></section>}
  </main>;

  const aliases = status?.agentAliases ?? [], allowlist = status?.allowlist ?? [];
  const externalInvites = (status?.invitations ?? []).filter(invitation => invitation.external_invite === 1);

  return <main>
    {header}
    <section className="intro"><p className="eyebrow">YOUR CALENDAR, YOUR CHOICE</p><h1>Choose the calendar<br/>your agents can see.</h1><p>Keep scheduling in your native calendar. Connect an account, enable the calendars that may emit MCP Events, then invite an agent alias as a guest.</p></section>
    {errorBanner}
    <div className="steps">
      <section className="panel" aria-labelledby="connection-title"><div className="step">01 / CONNECTION</div><h2 id="connection-title">Connect Google</h2><p>Connecting discovers calendars without enabling any of them.</p>
        {status?.connected
          ? <div className="connection"><span>Google connected</span><button data-testid="disconnect-google" disabled={busy} onClick={() => action('/api/google/disconnect')}>Disconnect</button></div>
          : <form method="post" action="/api/google/connect"><button className="primary" data-testid="connect-google" disabled={!status?.oauthReady || busy}>Connect Google</button></form>}
        {!status?.oauthReady && status && <p className="muted">Configure Google OAuth environment variables on this server to connect.</p>}
      </section>

      <section className="panel" aria-labelledby="calendars-title"><div className="step">02 / CALENDAR PERMISSIONS</div><h2 id="calendars-title">Enable a calendar</h2><p>Every calendar starts disabled. Newly shared calendars fail closed until you explicitly enable them.</p>
        {!status?.connected && <div className="empty">Your calendars will appear after you connect a calendar provider.</div>}
        {status?.connected && calendars.length === 0 && !error && <div className="empty">No accessible calendars found.</div>}
        <ul>{calendars.map(calendar => <CalendarRow key={calendar.id} calendar={calendar} status={status} busy={busy} action={action} />)}</ul>
      </section>

      <section className="panel" aria-labelledby="aliases-title"><div className="step">03 / AGENT GUEST ALIASES</div><h2 id="aliases-title">Agent aliases</h2>
        <p>Add dedicated agent email aliases to invite as calendar guests. Task definitions stay on your agent host.</p>
        <form className="inline-form" onSubmit={submit('/api/agents/add', ['email', 'label'])} aria-label="Add agent alias">
          <input name="email" type="email" required placeholder="agent+research@example.com" aria-label="Agent alias email" data-testid="alias-email-input" />
          <input name="label" type="text" maxLength={80} placeholder="Label (optional)" aria-label="Agent alias label" data-testid="alias-label-input" />
          <button type="submit" disabled={busy || !status?.connected} data-testid="alias-add">Add alias</button>
        </form>
        {aliases.length === 0 ? <div className="empty">No agent aliases yet.</div> : <ul>{aliases.map(alias => <li key={alias.email} data-testid="alias-row">
          <div className="calendar-main"><strong>{alias.label || alias.email}</strong>{alias.label && <span className="muted">{alias.email}</span>}</div>
          <button disabled={busy} aria-label={`Remove agent alias ${alias.email}`} data-testid="alias-remove" onClick={() => action('/api/agents/remove', { email: alias.email })}>Remove</button>
        </li>)}</ul>}
      </section>

      <section className="panel" aria-labelledby="allowlist-title"><div className="step">04 / EXTERNAL INVITES</div><h2 id="allowlist-title">Allowlist and approvals</h2>
        <p>Only you and allowlisted organizers can invite an agent alias. Unallowlisted invites are blocked before reaching any agent.</p>
        <form className="inline-form" onSubmit={submit('/api/allowlist/add', ['email'])} aria-label="Add allowlisted organizer">
          <input name="email" type="email" required placeholder="colleague@example.com" aria-label="Organizer email" data-testid="allowlist-email-input" />
          <button type="submit" disabled={busy || !status?.connected} data-testid="allowlist-add">Allow organizer</button>
        </form>
        {allowlist.length === 0 ? <div className="empty">No external organizers are allowed.</div> : <ul>{allowlist.map(entry => <li key={entry.email} data-testid="allowlist-row">
          <span className="calendar-main">{entry.email}</span>
          <button disabled={busy} aria-label={`Remove allowlisted organizer ${entry.email}`} data-testid="allowlist-remove" onClick={() => action('/api/allowlist/remove', { email: entry.email })}>Remove</button>
        </li>)}</ul>}
        <h3>External invitations</h3>
        <p className="muted">Allowlisted invites still wait for your approval before any agent acts.</p>
        {externalInvites.length === 0 ? <div className="empty">No external invitations.</div> : <ul>{externalInvites.map(invitation => <InvitationRow key={invitation.id} invitation={invitation} busy={busy} action={action} />)}</ul>}
      </section>
    </div>

    <aside><div className="step">BRIDGE STATUS</div><h2>{status?.alarmReady ? 'Calendar alarms are configured.' : 'Configure alarms to schedule occurrences.'}</h2>
      <p>{status?.alarmReady ? `Resync an enabled calendar to register upcoming occurrences. ${status.dueWork} occurrence${status.dueWork === 1 ? '' : 's'} recorded as due work.` : 'Connect a calendar provider and start a watch to synchronize enabled calendars.'}</p>
      <p>{status?.eventStartReady ? 'MCP Events delivery is enabled. Subscribe from any MCP Events-compatible agent host.' : 'Event discovery is closed until ingress, alarms, and delivery readiness are configured.'}</p>
      <p>Started watches renew automatically within a day of expiry, and calendars resync every 15 minutes to recover missed pushes. Calendars you never started watching stay unwatched.</p>
      {status?.connected && <button data-testid="run-maintenance" disabled={busy} onClick={() => action('/api/maintenance/run')}>Run maintenance now</button>}
      <p className="muted">Timed events only, up to 366 days ahead. Calendar content never grants execution authority.</p>
    </aside>
    <footer>Calendar titles and descriptions are untrusted data. Calendar permission never authorizes an agent to execute arbitrary instructions.</footer>
  </main>;
}

type Action = (path: string, body?: Record<string, unknown> | string) => void;

function CalendarRow({ calendar, status, busy, action }: { calendar: SetupCalendar; status: SetupStatus | null; busy: boolean; action: Action }) {
  const checkedAt = status?.checkedAt ?? 0;
  const watch = status?.watches.find(w => w.calendar_id === calendar.id && w.status === 'active');
  const subscriptions = status?.subscriptions.find(s => s.calendar_id === calendar.id)?.count ?? 0;
  return <li data-testid="calendar-row" data-calendar-id={calendar.id}>
    <div className="calendar-main"><strong>{calendar.summary}</strong><span className="muted">{calendar.enabled ? 'Enabled by you' : 'Disabled'}</span></div>
    <div className="controls">
      <button data-testid="calendar-toggle" disabled={busy || calendar.accessRole === 'freeBusyReader'} onClick={() => action(calendar.enabled ? '/api/calendars/disable' : '/api/calendars/enable', calendar.id)}>{calendar.enabled ? 'Disable' : 'Enable'}</button>
      {calendar.enabled && <button data-testid="calendar-watch" disabled={busy || !status?.webhookVerified} onClick={() => action('/api/calendars/watch', calendar.id)}>{watch ? 'Renew watch' : 'Start watch'}</button>}
      {watch && <button data-testid="calendar-resync" disabled={busy || watch.expiration <= checkedAt} onClick={() => action('/api/calendars/resync', calendar.id)}>Resync now</button>}
      {subscriptions > 0 && <button data-testid="calendar-unsubscribe" disabled={busy} aria-label={`Stop event delivery for ${calendar.summary}`} onClick={() => action('/api/calendars/unsubscribe', calendar.id)}>Stop event delivery</button>}
    </div>
    {calendar.enabled && <div className="write-back">
      <span><strong>Write-back (RSVP &amp; run notes)</strong> <span className="muted">Opt-in, off by default. {calendar.writeBackEnabled ? 'Agents may RSVP and add brief run-status notes.' : 'Agents cannot write to this calendar.'}</span></span>
      <button data-testid="calendar-write-back" aria-pressed={Boolean(calendar.writeBackEnabled)} aria-label={`${calendar.writeBackEnabled ? 'Disable' : 'Enable'} write-back for ${calendar.summary}`} disabled={busy}
        onClick={() => action('/api/calendars/write-back', { calendarId: calendar.id, enabled: !calendar.writeBackEnabled })}>{calendar.writeBackEnabled ? 'Disable write-back' : 'Enable write-back'}</button>
    </div>}
    {subscriptions > 0 && <p className="muted">{subscriptions} event subscription{subscriptions === 1 ? '' : 's'}. Stop delivery here to revoke them for this calendar.</p>}
    {watch && watch.sync_failed > 0 && <p role="alert">Last sync failed. Use Resync now to fetch the latest calendar state.</p>}
    {watch && <p className="watch">{watch.expiration <= checkedAt ? 'Watch expired' : 'Watch expires'} {formatTime(watch.expiration)}{watch.synced_at ? ` · Last sync ${formatTime(watch.synced_at)}` : ''}</p>}
  </li>;
}

function InvitationRow({ invitation, busy, action }: { invitation: SetupInvitation; busy: boolean; action: Action }) {
  const state = ['pending', 'approved', 'rejected'].includes(invitation.approval_status) ? invitation.approval_status : 'pending';
  return <li data-testid="invitation-row" data-invitation-id={invitation.id}>
    <div className="calendar-main">
      <span><span className={`badge ${state}`} data-testid="invitation-status">{state}</span> {invitation.organizer_email ?? 'Unknown organizer'} → {invitation.agent_email}</span>
      <span className="untrusted" title="Untrusted calendar text"><span className="muted">Untrusted calendar text:</span> {invitation.event_title ?? 'Untitled event'}{invitation.event_start ? ` · ${formatTime(invitation.event_start)}` : ''}</span>
    </div>
    <div className="controls">
      {state !== 'approved' && <button className="primary" disabled={busy} data-testid="invitation-approve" aria-label={`Approve invitation from ${invitation.organizer_email ?? 'unknown organizer'}`} onClick={() => action('/api/invitations/approve', { invitationId: invitation.id })}>Approve</button>}
      {state !== 'rejected' && <button disabled={busy} data-testid="invitation-reject" aria-label={`Reject invitation from ${invitation.organizer_email ?? 'unknown organizer'}`} onClick={() => action('/api/invitations/reject', { invitationId: invitation.id })}>Reject</button>}
    </div>
  </li>;
}
