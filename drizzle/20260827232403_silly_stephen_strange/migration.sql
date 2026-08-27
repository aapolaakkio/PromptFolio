ALTER TABLE `imports` ADD `inserted_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `imports` ADD `skipped_count` integer DEFAULT 0 NOT NULL;