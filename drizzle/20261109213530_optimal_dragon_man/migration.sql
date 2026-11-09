PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_monthly_plan` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`user_id` text NOT NULL,
	`instrument_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `fk_monthly_plan_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_monthly_plan_instrument_id_instruments_id_fk` FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON DELETE CASCADE,
	CONSTRAINT `monthly_plan_user_id_instrument_id_unique` UNIQUE(`user_id`,`instrument_id`),
	CONSTRAINT "monthly_plan_amount_positive" CHECK("amount_minor" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_monthly_plan`(`id`, `user_id`, `instrument_id`, `amount_minor`, `created_at`) SELECT `id`, `user_id`, `instrument_id`, `amount_minor`, `created_at` FROM `monthly_plan`;--> statement-breakpoint
DROP TABLE `monthly_plan`;--> statement-breakpoint
ALTER TABLE `__new_monthly_plan` RENAME TO `monthly_plan`;--> statement-breakpoint
PRAGMA foreign_keys=ON;