CREATE TABLE `account` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`password` text,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_account_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`broker` text NOT NULL,
	`base_currency` text DEFAULT 'EUR' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `fk_accounts_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `fx_rates` (
	`date` text NOT NULL,
	`currency` text NOT NULL,
	`rate_eur` integer NOT NULL,
	CONSTRAINT `fx_rates_pk` PRIMARY KEY(`date`, `currency`)
);
--> statement-breakpoint
CREATE TABLE `imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`filename` text NOT NULL,
	`sha256` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `fk_imports_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `instruments` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`isin` text NOT NULL UNIQUE,
	`ticker` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`currency` text NOT NULL,
	`price_source` text NOT NULL,
	`source_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `price_fetch_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`source` text NOT NULL,
	`instrument_id` integer,
	`run_at` integer NOT NULL,
	`ok` integer NOT NULL,
	`message` text,
	CONSTRAINT `fk_price_fetch_log_instrument_id_instruments_id_fk` FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `prices` (
	`instrument_id` integer NOT NULL,
	`date` text NOT NULL,
	`close` integer NOT NULL,
	`currency` text NOT NULL,
	`source` text NOT NULL,
	`fetched_at` integer NOT NULL,
	CONSTRAINT `prices_pk` PRIMARY KEY(`instrument_id`, `date`),
	CONSTRAINT `fk_prices_instrument_id_instruments_id_fk` FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`token` text NOT NULL UNIQUE,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_session_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `snapshot_rows` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`snapshot_id` integer NOT NULL,
	`instrument_id` integer NOT NULL,
	`quantity` integer NOT NULL,
	`nav` integer NOT NULL,
	`market_value` integer NOT NULL,
	CONSTRAINT `fk_snapshot_rows_snapshot_id_snapshots_id_fk` FOREIGN KEY (`snapshot_id`) REFERENCES `snapshots`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_snapshot_rows_instrument_id_instruments_id_fk` FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`)
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` integer NOT NULL,
	`as_of` text NOT NULL,
	`source` text NOT NULL,
	`import_id` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `fk_snapshots_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_snapshots_import_id_imports_id_fk` FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`)
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`account_id` integer NOT NULL,
	`instrument_id` integer,
	`type` text NOT NULL,
	`trade_date` text NOT NULL,
	`quantity` integer DEFAULT 0 NOT NULL,
	`unit_price` integer,
	`amount` integer DEFAULT 0 NOT NULL,
	`fee` integer DEFAULT 0 NOT NULL,
	`tax` integer DEFAULT 0 NOT NULL,
	`currency` text NOT NULL,
	`fx_rate_eur` integer NOT NULL,
	`external_id` text,
	`content_hash` text NOT NULL,
	`import_id` integer,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `fk_transactions_account_id_accounts_id_fk` FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_transactions_instrument_id_instruments_id_fk` FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`),
	CONSTRAINT `fk_transactions_import_id_imports_id_fk` FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`),
	CONSTRAINT `txn_external_uq` UNIQUE(`account_id`,`external_id`),
	CONSTRAINT `txn_hash_uq` UNIQUE(`account_id`,`content_hash`)
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`email` text NOT NULL UNIQUE,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `accounts_user_idx` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE INDEX `price_log_run_idx` ON `price_fetch_log` (`run_at`);--> statement-breakpoint
CREATE INDEX `txn_account_date_idx` ON `transactions` (`account_id`,`trade_date`);--> statement-breakpoint
CREATE INDEX `txn_import_idx` ON `transactions` (`import_id`);