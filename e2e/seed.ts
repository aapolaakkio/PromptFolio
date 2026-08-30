import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
 * A database of its own for the browser tests: deleted, migrated and given the
 * instruments the fixture import needs. Nothing else is seeded -- the account
 * and the owner are created through the pages, which is the point of the run.
 */
const seed = async (): Promise<void> => {
  const path = resolve("./e2e/.tmp/e2e.db");
  mkdirSync(dirname(path), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });

  const { openDb, migrate } = await import("../src/server/db/index.ts");
  const { addInstrument } = await import("../src/server/instruments/store.ts");

  const handle = openDb(path);
  try {
    migrate(handle.db);
    for (const instrument of FIXTURE_INSTRUMENTS) {
      addInstrument(handle.db, {
        ...instrument,
        ticker: null,
        currency: EUR,
        priceSource: "manual",
        sourceKey: instrument.isin,
      });
    }
  } finally {
    handle.sqlite.close();
  }
};

await seed();
