CREATE TABLE `debt_balances` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`debt_id` integer NOT NULL,
	`as_of` text NOT NULL,
	`owed_minor` integer NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`import_id` integer,
	CONSTRAINT `fk_debt_balances_debt_id_debts_id_fk` FOREIGN KEY (`debt_id`) REFERENCES `debts`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_debt_balances_import_id_imports_id_fk` FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`),
	CONSTRAINT `debt_balances_debt_id_as_of_unique` UNIQUE(`debt_id`,`as_of`),
	CONSTRAINT "debt_balances_owed_non_negative" CHECK("owed_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE `debts` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`interest_rate_bp` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `fk_debts_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
