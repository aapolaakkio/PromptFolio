CREATE TABLE `spending_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`user_id` text NOT NULL,
	`pattern` text NOT NULL,
	`category` text NOT NULL,
	`source` text DEFAULT 'user' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `fk_spending_rules_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `spending_rule_uq` UNIQUE(`user_id`,`pattern`)
);
