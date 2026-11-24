import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const connections = sqliteTable('connections', { owner: text('owner').primaryKey(), refreshToken: text('refresh_token').notNull(), ownerEmail: text('owner_email'), createdAt: integer('created_at').notNull(), providerId: text('provider_id').notNull().default('google'), connectionId: text('connection_id').notNull().default('') });
export const oauthStates = sqliteTable('oauth_states', { state: text('state').primaryKey(), owner: text('owner').notNull(), verifier: text('verifier').notNull(), expiresAt: integer('expires_at').notNull() });
export const calendars = sqliteTable('calendars', { owner: text('owner').notNull(), calendarId: text('calendar_id').notNull(), summary: text('summary').notNull(), enabled: integer('enabled').notNull().default(0), writeBackEnabled: integer('write_back_enabled').notNull().default(0), ownerCalendar: integer('owner_calendar').notNull().default(0), generation: text('generation').notNull() }, t => [primaryKey({ columns: [t.owner, t.calendarId] })]);
export const watches = sqliteTable('watches', { id: text('id').primaryKey(), owner: text('owner').notNull(), calendarId: text('calendar_id').notNull(), generation: text('generation').notNull(), tokenHash: text('token_hash').notNull(), resourceId: text('resource_id'), expiration: integer('expiration').notNull(), status: text('status').notNull(), lastMessage: text('last_message'), syncedAt: integer('synced_at'), syncFailed: integer('sync_failed').notNull().default(0), syncUntil: integer('sync_until').notNull().default(0), providerId:text('provider_id').notNull().default('google'),connectionId:text('connection_id').notNull().default('') });
export const events = sqliteTable('events', { owner: text('owner').notNull(), calendarId: text('calendar_id').notNull(), providerEventId: text('provider_event_id').notNull(), payload: text('payload').notNull() }, t => [primaryKey({ columns: [t.owner, t.calendarId, t.providerEventId] })]);
export const occurrenceOutbox = sqliteTable('occurrence_outbox', {
  id: text('id').primaryKey(), owner: text('owner').notNull(), calendarId: text('calendar_id').notNull(), generation: text('generation').notNull(),
  providerId: text('provider_id').notNull().default('google'), connectionId: text('connection_id').notNull().default(''),
  eventName: text('event_name').notNull().default('calendar.event.starting'), agentEmail: text('agent_email').notNull().default(''),
  leadTimeMinutes: integer('lead_time_minutes').notNull().default(0),
  invitationId: text('invitation_id'),
  providerEventId: text('provider_event_id').notNull(), dueAt: integer('due_at').notNull(), createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(), payload: text('payload').notNull(), status: text('status').notNull().default('pending'),
}, t => [index('idx_occurrence_outbox_created_at').on(t.createdAt), index('idx_occurrence_outbox_owner_calendar').on(t.owner, t.calendarId)]);

export const subscriptions = sqliteTable('subscriptions', {
  id: text('id').primaryKey(), owner: text('owner').notNull(), calendarId: text('calendar_id').notNull(), generation: text('generation').notNull(),
  eventName: text('event_name').notNull().default('calendar.event.starting'), agentEmail: text('agent_email').notNull().default(''),
  leadTimeMinutes: integer('lead_time_minutes').notNull().default(0),
  callbackUrl: text('callback_url').notNull(), secret: text('secret').notNull(), previousSecret: text('previous_secret'), rotationUntil: integer('rotation_until'),
  expiresAt: integer('expires_at').notNull(), verifiedAt: integer('verified_at').notNull(), revision: text('revision').notNull(),
}, t => [index('idx_subscriptions_owner_calendar').on(t.owner, t.calendarId)]);
// Revisions invalidate in-flight verification on unsubscribe, including first-time creation.
export const subscriptionAttempts = sqliteTable('subscription_attempts', {
  agentEmail: text('agent_email').notNull().default(''),
  id: text('id').primaryKey(), owner: text('owner').notNull(), calendarId: text('calendar_id').notNull(), revision: text('revision').notNull(), expiresAt: integer('expires_at').notNull(),
});

export const deliveries = sqliteTable('deliveries', {
  outboxId: text('outbox_id').notNull(), subscriptionId: text('subscription_id').notNull(),
  owner: text('owner').notNull(), calendarId: text('calendar_id').notNull(),
  body: text('body').notNull(), status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0), nextAt: integer('next_at').notNull(),
  lease: text('lease'), leaseUntil: integer('lease_until').notNull().default(0), lastStatus: integer('last_status'),
}, t => [primaryKey({ columns: [t.outboxId, t.subscriptionId] }), index('idx_deliveries_owner_calendar').on(t.owner, t.calendarId)]);

export const agentAliases = sqliteTable('agent_aliases', {
  owner: text('owner').notNull(), email: text('email').notNull(), label: text('label').notNull().default(''),
  createdAt: integer('created_at').notNull(),
}, t => [primaryKey({ columns: [t.owner, t.email] })]);

export const inviteAllowlist = sqliteTable('invite_allowlist', {
  owner: text('owner').notNull(), email: text('email').notNull(), createdAt: integer('created_at').notNull(),
}, t => [primaryKey({ columns: [t.owner, t.email] })]);

export const agentInvitations = sqliteTable('agent_invitations', {
  id: text('id').primaryKey(), owner: text('owner').notNull(), calendarId: text('calendar_id').notNull(),
  generation: text('generation').notNull(), connectionId: text('connection_id').notNull().default(''),
  invitationKey: text('invitation_key').notNull(), agentEmail: text('agent_email').notNull(),
  providerEventId: text('provider_event_id').notNull(), organizerEmail: text('organizer_email'),
  externalInvite: integer('external_invite').notNull().default(0),
  approvalStatus: text('approval_status', { enum: ['owner', 'pending', 'approved', 'rejected'] }).notNull(),
  eventTitle: text('event_title'), eventStart: text('event_start'), notifiedAt: integer('notified_at'),
  createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
}, t => [
  uniqueIndex('idx_agent_invitations_identity').on(t.owner, t.calendarId, t.generation, t.connectionId, t.invitationKey, t.agentEmail),
  index('idx_agent_invitations_owner_calendar').on(t.owner, t.calendarId),
]);
