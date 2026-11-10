ALTER TABLE `occurrence_outbox` ADD `provider_id` text DEFAULT 'google' NOT NULL;--> statement-breakpoint
ALTER TABLE `occurrence_outbox` ADD `connection_id` text DEFAULT '' NOT NULL;