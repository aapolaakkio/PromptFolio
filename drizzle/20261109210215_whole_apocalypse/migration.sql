CREATE TABLE `forecast_rates` (
	`user_id` text NOT NULL,
	`instrument_id` integer NOT NULL,
	`rate_bp` integer NOT NULL,
	CONSTRAINT `forecast_rates_pk` PRIMARY KEY(`user_id`, `instrument_id`),
	CONSTRAINT `fk_forecast_rates_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_forecast_rates_instrument_id_instruments_id_fk` FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON DELETE CASCADE
);
