import { EUR } from "../src/core/money.ts";

/** ISINs the Nordnet fixture names, which an import refuses to commit without. */
const FIXTURE_INSTRUMENTS = [
  {
    isin: "IE0002Y8CX98",
    name: "WisdomTree Europe Defence UCITS ETF - EUR Acc",
    kind: "etf",
  },
  { isin: "SE0005993102", name: "Nordnet Suomi Indeksi", kind: "fund" },
  { isin: "IE00BG5J1M21", name: "HANetf Old Theme UCITS ETF - Acc", kind: "etf" },
  { isin: "IE00BJQTJ848", name: "HANetf New Theme UCITS ETF - Acc", kind: "etf" },
] as const;

/**
 * Gives the local D1 the instruments the fixture import needs. Nothing else is
 * seeded -- the account and the owner are created through the pages, which is
 * the point of the run.
 *
 * The database itself is not created or migrated here any more: that is
 * `pnpm run db:migrate:local`, against the D1 the Vite plugin serves.
 */
const seed = async (): Promise<void> => {
  const { db } = await import("../src/server/db/index.ts");
  const { addInstrument } = await import("../src/server/instruments/store.ts");

  for (const instrument of FIXTURE_INSTRUMENTS) {
    await addInstrument(db, {
      ...instrument,
      ticker: null,
      currency: EUR,
      priceSource: "manual",
      sourceKey: instrument.isin,
    });
  }
};

await seed();
