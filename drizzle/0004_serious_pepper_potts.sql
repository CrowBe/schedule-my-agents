CREATE TABLE `subscription_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`calendar_id` text NOT NULL,
	`revision` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`calendar_id` text NOT NULL,
	`generation` text NOT NULL,
	`callback_url` text NOT NULL,
	`secret` text NOT NULL,
	`previous_secret` text,
	`rotation_until` integer,
	`expires_at` integer NOT NULL,
	`verified_at` integer NOT NULL,
	`revision` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_subscriptions_owner_calendar` ON `subscriptions` (`owner`,`calendar_id`);