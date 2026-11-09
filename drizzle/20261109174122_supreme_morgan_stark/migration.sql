CREATE TABLE `page_recipes` (
	`instrument_id` integer PRIMARY KEY,
	`recipe` text,
	`asked_at` integer,
	CONSTRAINT `fk_page_recipes_instrument_id_instruments_id_fk` FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON DELETE CASCADE
);
