/** ISINs the Nordnet fixture names, which an import refuses to commit without. No prices: a holding is then valued at cost, so figures do not depend on the day the tests run. */
const FIXTURE_INSTRUMENTS = [
  ["IE0002Y8CX98", "WisdomTree Europe Defence UCITS ETF - EUR Acc", "etf"],
  ["SE0005993102", "Nordnet Suomi Indeksi", "fund"],
  ["IE00BG5J1M21", "HANetf Old Theme UCITS ETF - Acc", "etf"],
  ["IE00BJQTJ848", "HANetf New Theme UCITS ETF - Acc", "etf"],
] as const;

/** What every fresh e2e database starts with. The values are fixed text from this file, never input. */
export const seedSql = (): string =>
  FIXTURE_INSTRUMENTS.map(
    ([isin, name, kind]) =>
      `INSERT INTO instruments (isin, name, kind, currency, price_source, source_key) VALUES ('${isin}', '${name}', '${kind}', 'EUR', 'manual', '${isin}');`,
  ).join("\n");
