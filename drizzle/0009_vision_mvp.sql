CREATE TABLE `agent_aliases` (
	`owner` text NOT NULL,
	`email` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`owner`, `email`)
);
--> statement-breakpoint
CREATE TABLE `agent_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`calendar_id` text NOT NULL,
	`generation` text NOT NULL,
	`connection_id` text DEFAULT '' NOT NULL,
	`invitation_key` text NOT NULL,
	`agent_email` text NOT NULL,
	`provider_event_id` text NOT NULL,
	`organizer_email` text,
	`external_invite` integer DEFAULT 0 NOT NULL,
	`approval_status` text NOT NULL,
	`event_title` text,
	`event_start` text,
	`notified_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_invitations_identity` ON `agent_invitations` (`owner`,`calendar_id`,`generation`,`connection_id`,`invitation_key`,`agent_email`);--> statement-breakpoint
CREATE INDEX `idx_agent_invitations_owner_calendar` ON `agent_invitations` (`owner`,`calendar_id`);--> statement-breakpoint
CREATE TABLE `invite_allowlist` (
	`owner` text NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`owner`, `email`)
);
--> statement-breakpoint
ALTER TABLE `calendars` ADD `write_back_enabled` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `calendars` ADD `owner_calendar` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `owner_email` text;--> statement-breakpoint
ALTER TABLE `occurrence_outbox` ADD `event_name` text DEFAULT 'calendar.event.starting' NOT NULL;--> statement-breakpoint
ALTER TABLE `occurrence_outbox` ADD `agent_email` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `occurrence_outbox` ADD `lead_time_minutes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `occurrence_outbox` ADD `invitation_id` text;--> statement-breakpoint
ALTER TABLE `subscription_attempts` ADD `agent_email` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `event_name` text DEFAULT 'calendar.event.starting' NOT NULL;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `agent_email` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD `lead_time_minutes` integer DEFAULT 0 NOT NULL;