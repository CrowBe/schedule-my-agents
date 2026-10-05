CREATE TABLE `occurrence_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`calendar_id` text NOT NULL,
	`generation` text NOT NULL,
	`provider_event_id` text NOT NULL,
	`due_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_occurrence_outbox_created_at` ON `occurrence_outbox` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_occurrence_outbox_owner_calendar` ON `occurrence_outbox` (`owner`,`calendar_id`);