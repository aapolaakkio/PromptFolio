-- Hand-adjusted from drizzle-kit's output. The generated version wrapped the
-- table rebuild in `PRAGMA foreign_keys=OFF`, which SQLite ignores inside a
-- transaction -- and the migrator runs every migration in one. `DROP TABLE
-- instruments` then failed against the live foreign keys in transactions and
-- prices. `defer_foreign_keys` is the pragma that does work inside a
-- transaction: constraints are checked at COMMIT, by which point the rebuilt
-- table carries the same ids and every reference resolves again.
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_instruments` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`isin` text UNIQUE,
	`ticker` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`currency` text NOT NULL,
	`price_source` text NOT NULL,
	`source_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_instruments`(`id`, `isin`, `ticker`, `name`, `kind`, `currency`, `price_source`, `source_key`, `created_at`) SELECT `id`, `isin`, `ticker`, `name`, `kind`, `currency`, `price_source`, `source_key`, `created_at` FROM `instruments`;--> statement-breakpoint
DROP TABLE `instruments`;--> statement-breakpoint
ALTER TABLE `__new_instruments` RENAME TO `instruments`;
