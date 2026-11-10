ALTER TABLE `watches` ADD `provider_id` text DEFAULT 'google' NOT NULL;--> statement-breakpoint
ALTER TABLE `watches` ADD `connection_id` text DEFAULT '' NOT NULL;