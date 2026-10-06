CREATE TABLE `deliveries` (
	`outbox_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`owner` text NOT NULL,
	`calendar_id` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_at` integer NOT NULL,
	`lease` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`last_status` integer,
	PRIMARY KEY(`outbox_id`, `subscription_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_deliveries_owner_calendar` ON `deliveries` (`owner`,`calendar_id`);