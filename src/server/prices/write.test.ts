import { expect, test } from "bun:test";

import { EUR, parseCurrency } from "../../core/money";
import { testDb } from "../db";
import { instruments, prices } from "../db/schema";
import { MAX_PLAUSIBLE_RATIO, writePrices } from "./write";

const SEK = parseCurrency("SEK");

const seedInstrument = (db: ReturnType<typeof testDb>["db"]) =>
  db
    .insert(instruments)
    .values({
      // A fresh id per call: `instruments.isin` is unique, and this file's
      // tests all share one testDb() instance's own isolated database, but
      // each test still gets its own instrument to keep prices unambiguous.
      isin: crypto.randomUUID(),
      ticker: "NOKIA.HE",
      name: "Nokia",
      kind: "stock",
      currency: EUR,
      priceSource: "yahoo",
      sourceKey: "NOKIA.HE",
    })
    .returning()
    .get();

test("writes a first-ever price with no baseline to compare against, regardless of magnitude", () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  const result = writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-27", closeMinor: 1_000_000, currency: EUR },
  ]);
  expect(result).toEqual({ written: 1, rejectedImplausible: 0 });
  expect(db.select().from(prices).all()).toHaveLength(1);
});

test("upserts by (instrumentId, date): a re-run for the same date overwrites, not duplicates", () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  writePrices(db, instrument.id, "yahoo", [{ date: "2026-08-27", closeMinor: 431, currency: EUR }]);
  const result = writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-27", closeMinor: 440, currency: EUR },
  ]);
  expect(result).toEqual({ written: 1, rejectedImplausible: 0 });
  const rows = db.select().from(prices).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.close).toBe(440);
});

test("accepts an ordinary day-over-day move", () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  writePrices(db, instrument.id, "yahoo", [{ date: "2026-08-26", closeMinor: 415, currency: EUR }]);
  const result = writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-27", closeMinor: 431, currency: EUR },
  ]);
  expect(result).toEqual({ written: 1, rejectedImplausible: 0 });
});

test(`rejects a jump of more than ${MAX_PLAUSIBLE_RATIO}x, keeping the prior stored price`, () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  writePrices(db, instrument.id, "yahoo", [{ date: "2026-08-26", closeMinor: 400, currency: EUR }]);
  const result = writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-27", closeMinor: 400 * MAX_PLAUSIBLE_RATIO + 1, currency: EUR },
  ]);
  expect(result).toEqual({ written: 0, rejectedImplausible: 1 });
  const rows = db.select().from(prices).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ date: "2026-08-26", close: 400 });
});

test(`rejects a drop to less than 1/${MAX_PLAUSIBLE_RATIO} of the prior price`, () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-26", closeMinor: 10_000, currency: EUR },
  ]);
  const result = writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-27", closeMinor: 999, currency: EUR },
  ]);
  expect(result).toEqual({ written: 0, rejectedImplausible: 1 });
});

test(`accepts a move of exactly ${MAX_PLAUSIBLE_RATIO}x -- the boundary is inclusive`, () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  writePrices(db, instrument.id, "yahoo", [{ date: "2026-08-26", closeMinor: 400, currency: EUR }]);
  const result = writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-27", closeMinor: 400 * MAX_PLAUSIBLE_RATIO, currency: EUR },
  ]);
  expect(result).toEqual({ written: 1, rejectedImplausible: 0 });
});

test("never compares across a currency change -- accepted regardless of magnitude", () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  writePrices(db, instrument.id, "nordnet_fund", [
    { date: "2026-08-26", closeMinor: 400, currency: EUR },
  ]);
  const result = writePrices(db, instrument.id, "nordnet_fund", [
    { date: "2026-08-27", closeMinor: 400 * MAX_PLAUSIBLE_RATIO * 5, currency: SEK },
  ]);
  expect(result).toEqual({ written: 1, rejectedImplausible: 0 });
});

test("within one batch, each point is checked against the previous point already written in that same batch", () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  const result = writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-24", closeMinor: 400, currency: EUR },
    { date: "2026-08-25", closeMinor: 420, currency: EUR }, // plausible vs. day 24
    { date: "2026-08-26", closeMinor: 420 * MAX_PLAUSIBLE_RATIO + 1, currency: EUR }, // implausible vs. day 25 -> rejected
    { date: "2026-08-27", closeMinor: 430, currency: EUR }, // plausible vs. day 25 (26 was never written)
  ]);
  expect(result).toEqual({ written: 3, rejectedImplausible: 1 });
  const rows = db
    .select()
    .from(prices)
    .all()
    .map((r) => r.date)
    .sort();
  expect(rows).toEqual(["2026-08-24", "2026-08-25", "2026-08-27"]);
});

test("writes zero points for an empty fetch without error", () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  expect(writePrices(db, instrument.id, "manual", [])).toEqual({
    written: 0,
    rejectedImplausible: 0,
  });
});
