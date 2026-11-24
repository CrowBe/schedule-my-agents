import { AppError, type Database, type CalendarEvent, type CalendarEventName } from './types.ts';
import { random } from './crypto.ts';
import { attendeeEmails, eventProvenance, invitationKey, normalizeEmail, organizer } from './provenance.ts';
export type CalendarRow = { owner: string; calendar_id: string; summary: string; enabled: number; generation: string; write_back_enabled: number; owner_calendar: number };
export type WatchRow = { id: string; owner: string; calendar_id: string; generation: string; token_hash: string; resource_id: string | null; expiration: number; status: string; last_message: string | null; synced_at: number | null; provider_id:string; connection_id:string };
export type CalendarConnection = { owner: string; id: string; providerId: string; legacy: boolean; created_at: number; ownerEmail: string | null };
export type ApprovalStatus = 'owner' | 'pending' | 'approved' | 'rejected';
export type InvitationRow = {
  id: string; owner: string; calendar_id: string; generation: string; connection_id: string;
  invitation_key: string; agent_email: string; provider_event_id: string; organizer_email: string | null;
  external_invite: number; approval_status: ApprovalStatus; event_title: string | null; event_start: string | null;
  notified_at: number | null; created_at: number; updated_at: number;
};
export type OutboxRow = {
  id: string; owner: string; calendar_id: string; generation: string; provider_id: string; connection_id: string;
  provider_event_id: string; payload: string; status: string; due_at: number; expires_at: number;
  event_name: CalendarEventName; agent_email: string; lead_time_minutes: number; invitation_id: string | null;
};

function persistedConnectionId(alias = '') {
  const column = alias ? alias + '.' : '';
  return `CASE WHEN ${column}connection_id = '' THEN 'legacy:' || ${column}provider_id || ':' || ${column}owner || ':' || ${column}created_at ELSE ${column}connection_id END`;
}
export const connectionIdentity = persistedConnectionId();
const connectionGuard = `EXISTS (SELECT 1 FROM connections WHERE owner = ? AND provider_id = ? AND ${connectionIdentity} = ?)`;
const grantGuard = 'EXISTS (SELECT 1 FROM calendars WHERE owner = ? AND calendar_id = ? AND enabled = 1 AND generation = ?)';
const aliasGuard = 'EXISTS (SELECT 1 FROM agent_aliases WHERE owner = ? AND email = ?)';
const allowlistGuard = 'EXISTS (SELECT 1 FROM invite_allowlist WHERE owner = ? AND email = ?)';
function receiptPayload(event: CalendarEvent) {
  const payload = { ...event };
  delete payload.attendees;
  return JSON.stringify(payload);
}
function emailAddress(value: string) {
  const email = normalizeEmail(value);
  if (!email) throw new AppError(400, 'A valid email address is required.');
  return email;
}
export class Store {
  private db: Database | undefined;
  constructor(db: Database | undefined) { this.db = db; if (!db) throw new AppError(503, 'Persistent storage is unavailable.'); }
  statement(sql: string, ...values: unknown[]) { return this.db!.prepare(sql).bind(...values); }
  async batch(statements: ReturnType<Store["statement"]>[]) { await this.db!.batch(statements); }
  async run(sql: string, ...values: unknown[]) { await this.statement(sql, ...values).run(); }
  async first<T>(sql: string, ...values: unknown[]) { return this.statement(sql, ...values).first<T>(); }
  async all<T>(sql: string, ...values: unknown[]) { return (await this.statement(sql, ...values).all<T>()).results; }
  async connection(owner: string): Promise<CalendarConnection | null> {
    const row = await this.first<{created_at:number;provider_id:string;connection_id:string;owner_email:string|null}>('SELECT created_at, provider_id, connection_id, owner_email FROM connections WHERE owner = ?', owner);
    return row ? { owner, created_at:row.created_at, providerId:row.provider_id,
      ownerEmail: row.owner_email, id:row.connection_id || `legacy:${row.provider_id}:${owner}:${row.created_at}`, legacy:!row.connection_id } : null;
  }
  async calendar(owner: string, id: string) { return this.first<CalendarRow>('SELECT * FROM calendars WHERE owner = ? AND calendar_id = ?', owner, id); }
  async requireEnabled(owner: string, id: string, generation?: string) {
    const row = await this.calendar(owner, id);
    if (!row?.enabled || (generation && row.generation !== generation)) throw new AppError(403, 'This calendar is not enabled.');
    return row;
  }
  async saveOwnerEmail(connection: CalendarConnection, email: string) {
    await this.run(`UPDATE connections SET owner_email = ? WHERE owner = ? AND provider_id = ? AND ${connectionIdentity} = ? AND owner_email IS NULL`,
      emailAddress(email), connection.owner, connection.providerId, connection.id);
  }
  async listAgentAliases(owner: string) {
    return this.all<{ email: string; label: string; created_at: number }>('SELECT email, label, created_at FROM agent_aliases WHERE owner = ? ORDER BY email', owner);
  }
  async hasAgentAlias(owner: string, email: string) {
    return Boolean(await this.first(`SELECT 1 WHERE ${aliasGuard}`, owner, email));
  }
  async addAgentAlias(owner: string, email: string, label: string, now: number) {
    await this.run('INSERT INTO agent_aliases (owner, email, label, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner, email) DO UPDATE SET label = excluded.label',
      owner, emailAddress(email), label, now);
  }
  async removeAgentAlias(owner: string, address: string) {
    const email = emailAddress(address);
    await this.batch([
      this.statement('DELETE FROM agent_aliases WHERE owner = ? AND email = ?', owner, email),
      this.statement(`DELETE FROM deliveries WHERE owner = ? AND (
        subscription_id IN (SELECT id FROM subscriptions WHERE owner = ? AND agent_email = ?)
        OR outbox_id IN (SELECT id FROM occurrence_outbox WHERE owner = ? AND agent_email = ?))`, owner, owner, email, owner, email),
      this.statement('DELETE FROM subscriptions WHERE owner = ? AND agent_email = ?', owner, email),
      this.statement('DELETE FROM subscription_attempts WHERE owner = ? AND agent_email = ?', owner, email),
      this.statement('DELETE FROM occurrence_outbox WHERE owner = ? AND agent_email = ?', owner, email),
      this.statement('DELETE FROM agent_invitations WHERE owner = ? AND agent_email = ?', owner, email),
    ]);
  }
  async listAllowlist(owner: string) {
    return this.all<{ email: string; created_at: number }>('SELECT email, created_at FROM invite_allowlist WHERE owner = ? ORDER BY email', owner);
  }
  async addAllowlist(owner: string, email: string, now: number) {
    await this.run('INSERT INTO invite_allowlist (owner, email, created_at) VALUES (?, ?, ?) ON CONFLICT(owner, email) DO NOTHING',
      owner, emailAddress(email), now);
  }
  private terminateInvitations(filter: string, ...args: unknown[]) {
    const receipts = `SELECT id FROM occurrence_outbox WHERE invitation_id IN (SELECT id FROM agent_invitations WHERE ${filter})`;
    return [
      this.statement(`UPDATE deliveries SET status = 'terminal', body = '', lease = NULL, lease_until = 0 WHERE status = 'pending' AND outbox_id IN (${receipts})`, ...args),
      this.statement(`UPDATE occurrence_outbox SET status = 'terminal', payload = '' WHERE id IN (${receipts})`, ...args),
    ];
  }
  async removeAllowlist(owner: string, address: string) {
    const email = emailAddress(address);
    const filter = 'owner = ? AND organizer_email = ? AND external_invite = 1';
    await this.batch([
      this.statement('DELETE FROM invite_allowlist WHERE owner = ? AND email = ?', owner, email),
      ...this.terminateInvitations(filter, owner, email),
      this.statement(`DELETE FROM agent_invitations WHERE ${filter}`, owner, email),
      this.statement(`DELETE FROM events WHERE owner = ? AND json_extract(payload, '$.organizerEmail') = ?
        AND json_extract(payload, '$.organizerSelf') IS NOT 1
        AND NOT EXISTS (SELECT 1 FROM connections WHERE owner = events.owner AND owner_email = ?)
        AND NOT EXISTS (SELECT 1 FROM calendars c WHERE c.owner = events.owner AND c.calendar_id = events.calendar_id
          AND c.owner_calendar = 1 AND lower(c.calendar_id) = ?)`, owner, email, email, email),
    ]);
  }
  async listInvitations(owner: string) {
    return this.all<InvitationRow>(`SELECT i.* FROM agent_invitations i JOIN connections n ON n.owner = i.owner
      JOIN calendars c ON c.owner = i.owner AND c.calendar_id = i.calendar_id AND c.generation = i.generation AND c.enabled = 1
      WHERE i.owner = ? AND i.connection_id = ${persistedConnectionId('n')} ORDER BY i.created_at DESC, i.id`, owner);
  }
  async setInvitationApproval(owner: string, id: string, status: 'approved' | 'rejected', now: number) {
    const filter = `id = ? AND owner = ? AND external_invite = 1
      AND EXISTS (SELECT 1 FROM calendars c WHERE c.owner = agent_invitations.owner AND c.calendar_id = agent_invitations.calendar_id
        AND c.enabled = 1 AND c.generation = agent_invitations.generation)
      AND EXISTS (SELECT 1 FROM connections n WHERE n.owner = agent_invitations.owner
        AND ${persistedConnectionId('n')} = agent_invitations.connection_id)
      AND EXISTS (SELECT 1 FROM agent_aliases a WHERE a.owner = agent_invitations.owner AND a.email = agent_invitations.agent_email)
      AND EXISTS (SELECT 1 FROM invite_allowlist a WHERE a.owner = agent_invitations.owner AND a.email = agent_invitations.organizer_email)`;
    await this.batch([
      this.statement(`UPDATE agent_invitations SET approval_status = ?, updated_at = ? WHERE ${filter}`, status, now, id, owner),
      ...(status === 'rejected' ? this.terminateInvitations(`${filter} AND approval_status = 'rejected'`, id, owner) : []),
    ]);
    const row = await this.first<InvitationRow>(`SELECT * FROM agent_invitations WHERE ${filter}`, id, owner);
    if (!row) throw new AppError(404, 'This external invitation is unavailable.');
    return row;
  }
  async setWriteBackEnabled(owner: string, calendarId: string, enabled: boolean) {
    if (!await this.first('UPDATE calendars SET write_back_enabled = ? WHERE owner = ? AND calendar_id = ? AND enabled = 1 RETURNING calendar_id',
      enabled ? 1 : 0, owner, calendarId)) throw new AppError(403, 'This calendar is not enabled.');
  }
  async activeLeadTimes(owner: string, calendarId: string, generation: string, now: number) {
    const rows = await this.all<{ lead_time_minutes: number }>(`SELECT DISTINCT s.lead_time_minutes FROM subscriptions s
      WHERE s.owner = ? AND s.calendar_id = ? AND s.generation = ? AND s.expires_at > ? AND s.verified_at > 0
        AND s.event_name = 'calendar.event.starting' AND s.lead_time_minutes BETWEEN 1 AND 1440
        AND (s.agent_email = '' OR EXISTS (SELECT 1 FROM agent_aliases a WHERE a.owner = s.owner AND a.email = s.agent_email))`,
      owner, calendarId, generation, now);
    return [0, ...rows.map(row => row.lead_time_minutes)];
  }
  async authorizeEvent(connection: CalendarConnection, generation: string, event: CalendarEvent, email: string,
    eventName: CalendarEventName, writeBack = false) {
    if (event.status === 'cancelled' || event.provider !== connection.providerId || (email && !attendeeEmails(event).has(email))) return null;
    const organizerEmail = normalizeEmail(event.organizerEmail);
    const row = await this.first<{
      owner_calendar: number; owner_email: string | null; allowlisted: number;
      invitation_id: string | null; organizer_email: string | null; external_invite: number | null; approval_status: ApprovalStatus | null;
    }>(`SELECT c.owner_calendar, n.owner_email, i.id AS invitation_id, i.organizer_email, i.external_invite, i.approval_status,
      EXISTS (SELECT 1 FROM invite_allowlist a WHERE a.owner = c.owner AND a.email = ?) AS allowlisted
      FROM calendars c JOIN connections n ON n.owner = c.owner
      LEFT JOIN agent_invitations i ON i.owner = c.owner AND i.calendar_id = c.calendar_id AND i.generation = c.generation
        AND i.connection_id = ? AND i.invitation_key = ? AND i.agent_email = ?
      WHERE c.owner = ? AND c.calendar_id = ? AND c.generation = ? AND c.enabled = 1
        AND n.provider_id = ? AND ${persistedConnectionId('n')} = ?
        AND (? = '' OR ${aliasGuard}) AND (? = 0 OR c.write_back_enabled = 1)`,
      organizerEmail ?? null, connection.id, invitationKey(event), email, connection.owner, event.calendarId, generation,
      connection.providerId, connection.id, email, connection.owner, email, Number(writeBack));
    if (!row) return null;
    const allowed = new Set(organizerEmail && row.allowlisted ? [organizerEmail] : []);
    const source = organizer(event, row.owner_email, row.owner_calendar === 1, allowed);
    if (source.kind === 'blocked' || (!email && source.kind !== 'owner')) return null;
    if (source.kind === 'owner' && eventName === 'calendar.event.starting') {
      return { provenance: eventProvenance(event, source, true), invitationId: null };
    }
    if (!row.invitation_id || row.organizer_email !== (source.email ?? null) ||
      row.external_invite !== Number(source.kind === 'allowlisted') || row.approval_status === 'rejected' ||
      (eventName === 'calendar.event.starting' && row.approval_status !== 'approved')) return null;
    return { provenance: eventProvenance(event, source, row.approval_status === 'approved'), invitationId: row.invitation_id };
  }
  private syncGuard(watch: WatchRow, connection: CalendarConnection, lease: number, now: number) {
    return {
      where: `${grantGuard} AND ${connectionGuard} AND EXISTS (SELECT 1 FROM watches WHERE id = ? AND owner = ?
        AND calendar_id = ? AND generation = ? AND status = 'active' AND expiration > ? AND sync_until = ? AND sync_until > ?)`,
      args: [watch.owner, watch.calendar_id, watch.generation, watch.owner, connection.providerId, connection.id,
        watch.id, watch.owner, watch.calendar_id, watch.generation, now, lease, now],
    };
  }
  async pruneInvitations(watch: WatchRow, connection: CalendarConnection, lease: number, now: number) {
    const { where, args } = this.syncGuard(watch, connection, lease, now);
    await this.run(`DELETE FROM agent_invitations WHERE owner = ? AND calendar_id = ? AND event_start < ? AND ${where}`,
      watch.owner, watch.calendar_id, new Date(now - 7 * 86400_000).toISOString(), ...args);
  }
  async upsertInvitation(watch: WatchRow, connection: CalendarConnection, event: CalendarEvent, email: string,
    source: ReturnType<typeof organizer>, lease: number, now: number) {
    if (source.kind === 'blocked') return null;
    const { where, args } = this.syncGuard(watch, connection, lease, now);
    const external = source.kind === 'allowlisted';
    const changed = 'agent_invitations.organizer_email IS NOT excluded.organizer_email OR agent_invitations.external_invite != excluded.external_invite';
    return this.first<InvitationRow>(`INSERT INTO agent_invitations (id, owner, calendar_id, generation, connection_id,
      invitation_key, agent_email, provider_event_id, organizer_email, external_invite, approval_status, event_title, event_start, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${where} AND ${aliasGuard}${external ? ' AND ' + allowlistGuard : ''}
      ON CONFLICT(owner, calendar_id, generation, connection_id, invitation_key, agent_email) DO UPDATE SET
        id = CASE WHEN ${changed} THEN excluded.id ELSE agent_invitations.id END,
        notified_at = CASE WHEN ${changed} THEN NULL ELSE agent_invitations.notified_at END,
        approval_status = CASE WHEN ${changed} THEN excluded.approval_status ELSE agent_invitations.approval_status END,
        organizer_email = excluded.organizer_email, external_invite = excluded.external_invite, provider_event_id = excluded.provider_event_id,
        event_title = excluded.event_title, event_start = excluded.event_start, updated_at = excluded.updated_at
      RETURNING *`, random(), watch.owner, watch.calendar_id, watch.generation, connection.id, invitationKey(event), email,
      event.providerEventId, source.email ?? null, Number(external), external ? 'pending' : 'owner',
      event.title?.slice(0, 512) ?? null, new Date(event.start).toISOString(), now, now,
      ...args, watch.owner, email, ...(external ? [watch.owner, source.email] : []));
  }
  async recordInvitationReceipt(id: string, invitation: InvitationRow, event: CalendarEvent, watch: WatchRow,
    connection: CalendarConnection, lease: number, now: number, expiresAt: number) {
    const { where, args } = this.syncGuard(watch, connection, lease, now);
    await this.batch([
      this.statement(`INSERT INTO occurrence_outbox (id, owner, calendar_id, generation, provider_event_id, due_at, created_at,
        expires_at, payload, provider_id, connection_id, event_name, agent_email, invitation_id)
        SELECT ?, i.owner, i.calendar_id, i.generation, i.provider_event_id, ?, ?, ?, ?, ?, i.connection_id, 'calendar.event.invited', i.agent_email, i.id
        FROM agent_invitations i WHERE i.id = ? AND i.notified_at IS NULL AND i.approval_status != 'rejected'
        AND ${where} ON CONFLICT(id) DO NOTHING`,
        id, now, now, expiresAt, receiptPayload(event), connection.providerId, invitation.id, ...args),
      this.statement(`UPDATE agent_invitations SET notified_at = ? WHERE id = ? AND notified_at IS NULL
        AND EXISTS (SELECT 1 FROM occurrence_outbox WHERE id = ? AND invitation_id = ?)`, now, invitation.id, id, invitation.id),
    ]);
    return this.outbox(id);
  }
  async outbox(id: string) { return this.first<OutboxRow>('SELECT * FROM occurrence_outbox WHERE id = ?', id); }

  async revokeSubscriptions(owner: string, calendarId: string) {
    await this.db!.batch([
      this.statement('DELETE FROM deliveries WHERE owner = ? AND calendar_id = ?', owner, calendarId),
      this.statement('DELETE FROM subscriptions WHERE owner = ? AND calendar_id = ?', owner, calendarId),
      this.statement('DELETE FROM subscription_attempts WHERE owner = ? AND calendar_id = ?', owner, calendarId),
    ]);
  }
  async disconnect(owner: string) {
    await this.db!.batch([
      this.statement('DELETE FROM deliveries WHERE owner = ?', owner),
      this.statement('DELETE FROM subscriptions WHERE owner = ?', owner),
      this.statement('DELETE FROM subscription_attempts WHERE owner = ?', owner),
      this.statement('DELETE FROM agent_invitations WHERE owner = ?', owner),
      this.statement('DELETE FROM connections WHERE owner = ?', owner),
      this.statement('DELETE FROM oauth_states WHERE owner = ?', owner),
      this.statement('DELETE FROM events WHERE owner = ?', owner),
      this.statement('DELETE FROM occurrence_outbox WHERE owner = ?', owner),
      this.statement('DELETE FROM calendars WHERE owner = ?', owner),
      this.statement("UPDATE watches SET status = 'revoked' WHERE owner = ?", owner),
    ]);
  }
  async revoke(owner: string, id: string, generation: string, expectedGeneration?: string) {
    const scope = `owner = ? AND calendar_id = ?${expectedGeneration === undefined ? '' : ' AND ' + grantGuard}`;
    const args = [owner, id, ...(expectedGeneration === undefined ? [] : [owner, id, expectedGeneration])];
    await this.batch([
      this.statement(`UPDATE watches SET status = 'revoked' WHERE ${scope}`, ...args),
      this.statement(`DELETE FROM deliveries WHERE ${scope}`, ...args),
      this.statement(`DELETE FROM subscriptions WHERE ${scope}`, ...args),
      this.statement(`DELETE FROM subscription_attempts WHERE ${scope}`, ...args),
      this.statement(`DELETE FROM agent_invitations WHERE ${scope}`, ...args),
      this.statement(`DELETE FROM events WHERE ${scope}`, ...args),
      this.statement(`DELETE FROM occurrence_outbox WHERE ${scope}`, ...args),
      this.statement(`UPDATE calendars SET enabled = 0, write_back_enabled = 0, owner_calendar = 0, generation = ? WHERE ${scope}`,
        generation, ...args),
    ]);
  }
  async replaceEvents(watch: WatchRow, events: { event: CalendarEvent; externalOrganizer?: string }[], now: number, connection?:CalendarConnection|null, syncUntil?:number) {
    // Generation and channel checks guard commits after consent revocation/renewal.
    const guard = `EXISTS (SELECT 1 FROM calendars c JOIN watches w ON w.owner = c.owner AND w.calendar_id = c.calendar_id WHERE c.owner = ? AND c.calendar_id = ? AND c.enabled = 1 AND c.generation = ? AND w.id = ? AND w.status = 'active' AND w.expiration > ?${syncUntil === undefined ? '' : ' AND w.sync_until = ? AND w.sync_until > ?'})` +
      (connection ? ` AND EXISTS (SELECT 1 FROM connections WHERE owner = ? AND provider_id = ? AND CASE WHEN connection_id = '' THEN 'legacy:' || provider_id || ':' || owner || ':' || created_at ELSE connection_id END = ?)` : '');
    const args = [watch.owner, watch.calendar_id, watch.generation, watch.id, now,...(syncUntil === undefined ? [] : [syncUntil, now]),...(connection?[connection.owner,connection.providerId,connection.id]:[])];
    await this.db!.batch([
      this.statement(`DELETE FROM events WHERE owner = ? AND calendar_id = ? AND ${guard}`, watch.owner, watch.calendar_id, ...args),
      ...events.map(({ event, externalOrganizer }) => this.statement(`INSERT OR REPLACE INTO events (owner, calendar_id, provider_event_id, payload)
        SELECT ?, ?, ?, ? WHERE ${guard}${externalOrganizer ? ' AND ' + allowlistGuard : ''}`,
        watch.owner, watch.calendar_id, event.providerEventId,
        JSON.stringify(externalOrganizer ? { ...event, organizerEmail: externalOrganizer } : event),
        ...args, ...(externalOrganizer ? [watch.owner, externalOrganizer] : []))),
      this.statement(`UPDATE watches SET synced_at = ?, sync_failed = CASE WHEN sync_failed = 2 THEN 1 ELSE 0 END WHERE id = ? AND ${guard}`, now, watch.id, ...args),
    ]);
  }
  async dueReceipts(owner: string, calendarId: string, generation: string, eventId: string, dueAt: number, leadTimeMinutes: number) {
    return this.all<{ id: string }>(`SELECT id FROM occurrence_outbox WHERE owner = ? AND calendar_id = ? AND generation = ?
      AND provider_event_id = ? AND due_at = ? AND event_name = 'calendar.event.starting' AND lead_time_minutes = ?`,
      owner, calendarId, generation, eventId, dueAt, leadTimeMinutes);
  }
  async claimDue(id: string, owner: string, calendarId: string, generation: string, event: CalendarEvent, dueAt: number, now: number, expiresAt: number, expectedConnection?: CalendarConnection,
    eventName: CalendarEventName = 'calendar.event.starting', agentEmail = '', leadTimeMinutes = 0, invitationId: string | null = null) {
    const connection = expectedConnection ?? await this.connection(owner);
    if (!connection || connection.providerId !== event.provider) return null;
    const scope='owner = ? AND calendar_id = ? AND generation = ? AND provider_event_id = ? AND due_at = ? AND provider_id = ? AND event_name = ? AND agent_email = ? AND lead_time_minutes = ? AND (connection_id = ? OR (connection_id = \'\' AND ? = 1))';
    const identity=[owner,calendarId,generation,event.providerEventId,dueAt,connection.providerId,eventName,agentEmail,leadTimeMinutes,connection.id,connection.legacy?1:0];
    // Bounded retention. Expired envelopes cannot replay after this ledger is removed.
    await this.run('DELETE FROM deliveries WHERE outbox_id IN (SELECT id FROM occurrence_outbox WHERE created_at < ? ORDER BY created_at LIMIT 100)', now - 7 * 86400_000);
    await this.run('DELETE FROM occurrence_outbox WHERE id IN (SELECT id FROM occurrence_outbox WHERE created_at < ? ORDER BY created_at LIMIT 100)', now - 7 * 86400_000);
    const row = await this.first<{id: string}>(`INSERT INTO occurrence_outbox (id, owner, calendar_id, generation, provider_event_id, due_at, created_at, expires_at, payload, provider_id, connection_id, status, event_name, agent_email, lead_time_minutes, invitation_id)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?
      WHERE ? >= ? AND ? <= ? AND ${connectionGuard} AND ${grantGuard}
      AND (? = '' OR ${aliasGuard})
      AND (? IS NULL OR EXISTS (SELECT 1 FROM agent_invitations i JOIN invite_allowlist a ON a.owner = i.owner AND a.email = i.organizer_email
        WHERE i.id = ? AND i.approval_status = 'approved'))
      AND NOT EXISTS (SELECT 1 FROM occurrence_outbox WHERE ${scope})
      ON CONFLICT(id) DO NOTHING RETURNING id`, id, owner, calendarId, generation, event.providerEventId, dueAt, now, expiresAt, receiptPayload(event), connection.providerId, connection.id,
      eventName, agentEmail, leadTimeMinutes, invitationId, now, dueAt, now, expiresAt, owner, connection.providerId, connection.id,
      owner, calendarId, generation, agentEmail, owner, agentEmail, invitationId, invitationId, ...identity);
    if(row) return {id:row.id,claimed:true};
    // Canonicalization may give a migrated alarm another ID for the same source
    // occurrence. Keep driving the original receipt/body instead of duplicating it.
    const existing=await this.first<{id:string}>(`SELECT id FROM occurrence_outbox WHERE ${scope} ORDER BY created_at LIMIT 1`,...identity);
    return existing?{id:existing.id,claimed:false}:null;
  }
}
