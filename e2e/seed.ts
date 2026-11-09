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

/** Seeds the instruments the fixture import needs; the account and owner are created through the pages. */
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
