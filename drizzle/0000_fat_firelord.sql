CREATE TABLE `calendars` (
	`owner` text NOT NULL,
	`calendar_id` text NOT NULL,
	`summary` text NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`generation` text NOT NULL,
	PRIMARY KEY(`owner`, `calendar_id`)
);
--> statement-breakpoint
CREATE TABLE `connections` (
	`owner` text PRIMARY KEY NOT NULL,
	`refresh_token` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`owner` text NOT NULL,
	`calendar_id` text NOT NULL,
	`provider_event_id` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`owner`, `calendar_id`, `provider_event_id`)
);
--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`verifier` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `watches` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`calendar_id` text NOT NULL,
	`generation` text NOT NULL,
	`token_hash` text NOT NULL,
	`resource_id` text,
	`expiration` integer NOT NULL,
	`status` text NOT NULL,
	`last_message` text,
	`synced_at` integer
);
