import { expect, test } from "vitest";

import { EUR, parseCurrency } from "../../core/money.ts";
import type { Db } from "../db/index.ts";
import { testDb } from "../db/test-db.ts";
import { instruments, pendingPriceRejections, prices } from "../db/schema.ts";
import { MAX_PLAUSIBLE_RATIO, RE_BASELINE_CONFIRMATIONS, writePrices } from "./write.ts";

const SEK = parseCurrency("SEK");

const seedInstrument = async (db: Db) =>
  await db
    .insert(instruments)
    .values({
      // A fresh id per call: `instruments.isin` is unique.
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

test("writes a first-ever price with no baseline to compare against, regardless of magnitude", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  const result = await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-27", closeMinor: 1_000_000, currency: EUR },
  ]);
  expect(result).toEqual({ written: 1, rejectedImplausible: 0, reBaselined: 0 });
  expect(await db.select().from(prices).all()).toHaveLength(1);
});

test("upserts by (instrumentId, date): a re-run for the same date overwrites, not duplicates", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-27", closeMinor: 431, currency: EUR },
  ]);
  const result = await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-27", closeMinor: 440, currency: EUR },
  ]);
  expect(result).toEqual({ written: 1, rejectedImplausible: 0, reBaselined: 0 });
  const rows = await db.select().from(prices).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ close: 440 });
});

test("accepts an ordinary day-over-day move", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-26", closeMinor: 415, currency: EUR },
  ]);
  const result = await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-27", closeMinor: 431, currency: EUR },
  ]);
  expect(result).toEqual({ written: 1, rejectedImplausible: 0, reBaselined: 0 });
});

test(`rejects a jump of more than ${MAX_PLAUSIBLE_RATIO}x, keeping the prior stored price`, async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-26", closeMinor: 400, currency: EUR },
  ]);
  const result = await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-27", closeMinor: 400 * MAX_PLAUSIBLE_RATIO + 1, currency: EUR },
  ]);
  expect(result).toEqual({ written: 0, rejectedImplausible: 1, reBaselined: 0 });
  const rows = await db.select().from(prices).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ date: "2026-08-26", close: 400 });
});

test(`rejects a drop to less than 1/${MAX_PLAUSIBLE_RATIO} of the prior price`, async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-26", closeMinor: 10_000, currency: EUR },
  ]);
  const result = await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-27", closeMinor: 999, currency: EUR },
  ]);
  expect(result).toEqual({ written: 0, rejectedImplausible: 1, reBaselined: 0 });
});

test(`accepts a move of exactly ${MAX_PLAUSIBLE_RATIO}x -- the boundary is inclusive`, async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-26", closeMinor: 400, currency: EUR },
  ]);
  const result = await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-27", closeMinor: 400 * MAX_PLAUSIBLE_RATIO, currency: EUR },
  ]);
  expect(result).toEqual({ written: 1, rejectedImplausible: 0, reBaselined: 0 });
});

test("never compares across a currency change -- accepted regardless of magnitude", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  await writePrices(db, instrument.id, "page", [
    { date: "2026-08-26", closeMinor: 400, currency: EUR },
  ]);
  const result = await writePrices(db, instrument.id, "page", [
    { date: "2026-08-27", closeMinor: 400 * MAX_PLAUSIBLE_RATIO * 5, currency: SEK },
  ]);
  expect(result).toEqual({ written: 1, rejectedImplausible: 0, reBaselined: 0 });
});

test("within one batch, each point is checked against the previous point already written in that same batch", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  const result = await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-24", closeMinor: 400, currency: EUR },
    { date: "2026-08-25", closeMinor: 420, currency: EUR }, // plausible vs. day 24
    { date: "2026-08-26", closeMinor: 420 * MAX_PLAUSIBLE_RATIO + 1, currency: EUR }, // implausible vs. day 25 -> rejected
    { date: "2026-08-27", closeMinor: 430, currency: EUR }, // plausible vs. day 25 (26 was never written)
  ]);
  expect(result).toEqual({ written: 3, rejectedImplausible: 1, reBaselined: 0 });
  const rows = (await db.select().from(prices).all()).map((r) => r.date).sort();
  expect(rows).toEqual(["2026-08-24", "2026-08-25", "2026-08-27"]);
});

test("writes zero points for an empty fetch without error", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  expect(await writePrices(db, instrument.id, "manual", [])).toEqual({
    written: 0,
    rejectedImplausible: 0,
    reBaselined: 0,
  });
});

// --- Self-healing re-baseline: a value repeated at a new scale across RE_BASELINE_CONFIRMATIONS writes becomes the baseline ---

test("a one-off implausible value stays rejected -- it does not confirm on its own", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-01", closeMinor: 400, currency: EUR },
  ]);
  const result = await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-02", closeMinor: 4_400, currency: EUR },
  ]);
  expect(result).toEqual({ written: 0, rejectedImplausible: 1, reBaselined: 0 });
  expect(await db.select().from(prices).all()).toHaveLength(1);
  const pending = await db.select().from(pendingPriceRejections).all();
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ instrumentId: instrument.id, close: 4_400, streak: 1 });
});

test(`the same new scale confirmed ${RE_BASELINE_CONFIRMATIONS} times in a row is accepted and re-baselines`, async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-01", closeMinor: 400, currency: EUR },
  ]);

  // A steep reverse split: each reading is an ordinary move from the last but >10x from the old 400 baseline.
  const first = await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-02", closeMinor: 4_400, currency: EUR },
  ]);
  expect(first).toEqual({ written: 0, rejectedImplausible: 1, reBaselined: 0 });

  const second = await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-03", closeMinor: 4_450, currency: EUR },
  ]);
  expect(second).toEqual({ written: 0, rejectedImplausible: 1, reBaselined: 0 });
  expect((await db.select().from(pendingPriceRejections).all())[0]).toMatchObject({
    close: 4_450,
    streak: 2,
  });

  const third = await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-04", closeMinor: 4_500, currency: EUR },
  ]);
  expect(third).toEqual({ written: 1, rejectedImplausible: 0, reBaselined: 1 });

  const rows = await db.select().from(prices).all();
  expect(rows).toHaveLength(2); // the original 2026-08-01 row, plus the re-baselined 2026-08-04 row.
  expect(rows.find((r) => r.date === "2026-08-04")).toMatchObject({ close: 4_500 });
  expect(await db.select().from(pendingPriceRejections).all()).toEqual([]);
});

test("a normal price after a re-baseline is compared against the new baseline, not the old one", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-01", closeMinor: 400, currency: EUR },
  ]);
  await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-02", closeMinor: 4_400, currency: EUR },
  ]);
  await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-03", closeMinor: 4_450, currency: EUR },
  ]);
  const reBaseline = await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-04", closeMinor: 4_500, currency: EUR },
  ]);
  expect(reBaseline.reBaselined).toBe(1);

  // Ordinary against the new baseline, but >10x against the original: the comparison point moved.
  const after = await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-05", closeMinor: 4_550, currency: EUR },
  ]);
  expect(after).toEqual({ written: 1, rejectedImplausible: 0, reBaselined: 0 });
  expect((await db.select().from(prices).all()).find((r) => r.date === "2026-08-05")).toMatchObject(
    {
      close: 4_550,
    },
  );
});

test("an unrelated second anomaly resets the confirmation streak instead of compounding with the first", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-01", closeMinor: 400, currency: EUR },
  ]);
  await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-02", closeMinor: 4_400, currency: EUR },
  ]);
  expect((await db.select().from(pendingPriceRejections).all())[0]).toMatchObject({
    close: 4_400,
    streak: 1,
  });

  // An unrelated implausible value (30 fails against both the baseline and the pending candidate) restarts the streak at 1.
  const unrelated = await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-03", closeMinor: 30, currency: EUR },
  ]);
  expect(unrelated).toEqual({ written: 0, rejectedImplausible: 1, reBaselined: 0 });
  expect((await db.select().from(pendingPriceRejections).all())[0]).toMatchObject({
    close: 30,
    streak: 1,
  });

  await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-04", closeMinor: 32, currency: EUR },
  ]);
  const third = await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-05", closeMinor: 33, currency: EUR },
  ]);
  expect(third).toEqual({ written: 1, rejectedImplausible: 0, reBaselined: 1 });
  expect((await db.select().from(prices).all()).find((r) => r.date === "2026-08-05")).toMatchObject(
    {
      close: 33,
    },
  );
});

test("a value that reverts to the original baseline's scale is accepted normally and clears the pending streak", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-01", closeMinor: 400, currency: EUR },
  ]);
  await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-02", closeMinor: 4_400, currency: EUR },
  ]);
  expect(await db.select().from(pendingPriceRejections).all()).toHaveLength(1);

  // The anomaly was transient: back to normal against the original baseline.
  const recovered = await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-03", closeMinor: 410, currency: EUR },
  ]);
  expect(recovered).toEqual({ written: 1, rejectedImplausible: 0, reBaselined: 0 });
  expect(await db.select().from(pendingPriceRejections).all()).toEqual([]);

  // The original spike's scale again starts a new streak at 1.
  const newAnomaly = await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-04", closeMinor: 4_400, currency: EUR },
  ]);
  expect(newAnomaly).toEqual({ written: 0, rejectedImplausible: 1, reBaselined: 0 });
  expect((await db.select().from(pendingPriceRejections).all())[0]).toMatchObject({
    close: 4_400,
    streak: 1,
  });
});

// --- skipPlausibilityCheck (manual entry): a human fix must not wait for a confirmation streak ---

test("skipPlausibilityCheck writes an implausible jump unconditionally instead of rejecting it", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-26", closeMinor: 400, currency: EUR },
  ]);
  const result = await writePrices(
    db,
    instrument.id,
    "manual",
    [{ date: "2026-08-27", closeMinor: 400 * MAX_PLAUSIBLE_RATIO + 1, currency: EUR }],
    { skipPlausibilityCheck: true },
  );
  expect(result).toEqual({ written: 1, rejectedImplausible: 0, reBaselined: 0 });
  const rows = await db.select().from(prices).all();
  expect(rows).toHaveLength(2);
  expect(rows.find((r) => r.date === "2026-08-27")).toMatchObject({
    close: 400 * MAX_PLAUSIBLE_RATIO + 1,
    source: "manual",
  });
});

test("skipPlausibilityCheck clears an in-flight pending-rejection streak for that instrument", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-01", closeMinor: 400, currency: EUR },
  ]);
  await writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-02", closeMinor: 4_400, currency: EUR },
  ]);
  expect(await db.select().from(pendingPriceRejections).all()).toHaveLength(1);

  // A manual correction supersedes whatever the automated source was disputing.
  const manual = await writePrices(
    db,
    instrument.id,
    "manual",
    [{ date: "2026-08-03", closeMinor: 410, currency: EUR }],
    { skipPlausibilityCheck: true },
  );
  expect(manual).toEqual({ written: 1, rejectedImplausible: 0, reBaselined: 0 });
  expect(await db.select().from(pendingPriceRejections).all()).toEqual([]);
});

test("skipPlausibilityCheck still upserts by (instrumentId, date), same as the checked path", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  await writePrices(
    db,
    instrument.id,
    "manual",
    [{ date: "2026-08-27", closeMinor: 100, currency: EUR }],
    {
      skipPlausibilityCheck: true,
    },
  );
  const result = await writePrices(
    db,
    instrument.id,
    "manual",
    [{ date: "2026-08-27", closeMinor: 200, currency: EUR }],
    { skipPlausibilityCheck: true },
  );
  expect(result).toEqual({ written: 1, rejectedImplausible: 0, reBaselined: 0 });
  const rows = await db.select().from(prices).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ close: 200 });
});
