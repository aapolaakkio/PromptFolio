CREATE TABLE `pending_price_rejections` (
	`instrument_id` integer PRIMARY KEY,
	`date` text NOT NULL,
	`close` integer NOT NULL,
	`currency` text NOT NULL,
	`streak` integer NOT NULL,
	CONSTRAINT `fk_pending_price_rejections_instrument_id_instruments_id_fk` FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON DELETE CASCADE
);
