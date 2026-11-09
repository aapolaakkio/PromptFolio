CREATE TABLE `instrument_costs` (
	`instrument_id` integer PRIMARY KEY,
	`ongoing_charge_bp` integer,
	`source_url` text,
	`checked_at` integer NOT NULL,
	`source` text NOT NULL,
	CONSTRAINT `fk_instrument_costs_instrument_id_instruments_id_fk` FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON DELETE CASCADE
);
