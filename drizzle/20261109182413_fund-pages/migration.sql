-- Custom SQL migration: OP and Nordnet funds become page instruments. --
UPDATE instruments SET price_source = 'page',
  source_key = 'https://www.op.fi/henkiloasiakkaat/saastot-ja-sijoitukset/rahastot/kaikki-rahastot/' || source_key
  WHERE price_source = 'op_fund';
--> statement-breakpoint
UPDATE instruments SET price_source = 'page',
  source_key = 'https://www.nordnet.fi/rahastot/lista/' || source_key
  WHERE price_source = 'nordnet_fund';
