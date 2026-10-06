import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';
export const connections = sqliteTable('connections', { owner: text('owner').primaryKey(), refreshToken: text('refresh_token').notNull(), createdAt: integer('created_at').notNull() });
export const oauthStates = sqliteTable('oauth_states', { state: text('state').primaryKey(), owner: text('owner').notNull(), verifier: text('verifier').notNull(), expiresAt: integer('expires_at').notNull() });
export const calendars = sqliteTable('calendars', { owner: text('owner').notNull(), calendarId: text('calendar_id').notNull(), summary: text('summary').notNull(), enabled: integer('enabled').notNull().default(0), generation: text('generation').notNull() }, t => [primaryKey({ columns: [t.owner, t.calendarId] })]);
export const watches = sqliteTable('watches', { id: text('id').primaryKey(), owner: text('owner').notNull(), calendarId: text('calendar_id').notNull(), generation: text('generation').notNull(), tokenHash: text('token_hash').notNull(), resourceId: text('resource_id'), expiration: integer('expiration').notNull(), status: text('status').notNull(), lastMessage: text('last_message'), syncedAt: integer('synced_at'), syncFailed: integer('sync_failed').notNull().default(0), syncUntil: integer('sync_until').notNull().default(0) });
export const events = sqliteTable('events', { owner: text('owner').notNull(), calendarId: text('calendar_id').notNull(), providerEventId: text('provider_event_id').notNull(), payload: text('payload').notNull() }, t => [primaryKey({ columns: [t.owner, t.calendarId, t.providerEventId] })]);
export const occurrenceOutbox = sqliteTable('occurrence_outbox', {
  id: text('id').primaryKey(), owner: text('owner').notNull(), calendarId: text('calendar_id').notNull(), generation: text('generation').notNull(),
  providerEventId: text('provider_event_id').notNull(), dueAt: integer('due_at').notNull(), createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(), payload: text('payload').notNull(), status: text('status').notNull().default('pending'),
}, t => [index('idx_occurrence_outbox_created_at').on(t.createdAt), index('idx_occurrence_outbox_owner_calendar').on(t.owner, t.calendarId)]);

export const subscriptions = sqliteTable('subscriptions', {
  id: text('id').primaryKey(), owner: text('owner').notNull(), calendarId: text('calendar_id').notNull(), generation: text('generation').notNull(),
  callbackUrl: text('callback_url').notNull(), secret: text('secret').notNull(), previousSecret: text('previous_secret'), rotationUntil: integer('rotation_until'),
  expiresAt: integer('expires_at').notNull(), verifiedAt: integer('verified_at').notNull(), revision: text('revision').notNull(),
}, t => [index('idx_subscriptions_owner_calendar').on(t.owner, t.calendarId)]);
// Revisions invalidate in-flight verification on unsubscribe, including first-time creation.
export const subscriptionAttempts = sqliteTable('subscription_attempts', {
  id: text('id').primaryKey(), owner: text('owner').notNull(), calendarId: text('calendar_id').notNull(), revision: text('revision').notNull(), expiresAt: integer('expires_at').notNull(),
});

export const deliveries = sqliteTable('deliveries', {
  outboxId: text('outbox_id').notNull(), subscriptionId: text('subscription_id').notNull(),
  owner: text('owner').notNull(), calendarId: text('calendar_id').notNull(),
  body: text('body').notNull(), status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0), nextAt: integer('next_at').notNull(),
  lease: text('lease'), leaseUntil: integer('lease_until').notNull().default(0), lastStatus: integer('last_status'),
}, t => [primaryKey({ columns: [t.outboxId, t.subscriptionId] }), index('idx_deliveries_owner_calendar').on(t.owner, t.calendarId)]);
