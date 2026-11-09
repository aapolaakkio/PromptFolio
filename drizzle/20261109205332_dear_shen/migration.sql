CREATE TABLE `monthly_plan` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`user_id` text NOT NULL,
	`instrument_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `fk_monthly_plan_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_monthly_plan_instrument_id_instruments_id_fk` FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON DELETE CASCADE,
	CONSTRAINT `monthly_plan_user_id_instrument_id_unique` UNIQUE(`user_id`,`instrument_id`)
);
