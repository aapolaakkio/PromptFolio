CREATE TABLE `instrument_lookups` (
	`key` text PRIMARY KEY,
	`outcome` text NOT NULL,
	`result` text NOT NULL,
	`checked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `yahoo_gate` (
	`id` integer PRIMARY KEY,
	`paused_until` integer,
	`backoff_ms` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `instruments` ADD `lookup_status` text DEFAULT 'ok' NOT NULL;