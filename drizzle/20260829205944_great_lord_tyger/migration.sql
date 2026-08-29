CREATE TABLE `allocation_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`user_id` text NOT NULL,
	`dimension` text NOT NULL,
	`key` text NOT NULL,
	`weight_bp` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT `fk_allocation_targets_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `allocation_targets_user_id_dimension_key_unique` UNIQUE(`user_id`,`dimension`,`key`)
);
