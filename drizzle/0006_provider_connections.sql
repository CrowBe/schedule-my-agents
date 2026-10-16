ALTER TABLE `connections` ADD `provider_id` text DEFAULT 'google' NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `connection_id` text DEFAULT '' NOT NULL;