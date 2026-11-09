CREATE TABLE `weekly_summaries` (
	`user_id` text NOT NULL,
	`week` text NOT NULL,
	`facts` text NOT NULL,
	`text` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `weekly_summaries_pk` PRIMARY KEY(`user_id`, `week`),
	CONSTRAINT `fk_weekly_summaries_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
