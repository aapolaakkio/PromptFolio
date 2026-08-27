import { expect, test } from "bun:test";

import { EUR, parseCurrency } from "../../core/money";
import { testDb } from "../db";
import { instruments, pendingPriceRejections, prices } from "../db/schema";
import { MAX_PLAUSIBLE_RATIO, RE_BASELINE_CONFIRMATIONS, writePrices } from "./write";

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
  expect(result).toEqual({ written: 1, rejectedImplausible: 0, reBaselined: 0 });
  expect(db.select().from(prices).all()).toHaveLength(1);
});

test("upserts by (instrumentId, date): a re-run for the same date overwrites, not duplicates", () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  writePrices(db, instrument.id, "yahoo", [{ date: "2026-08-27", closeMinor: 431, currency: EUR }]);
  const result = writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-27", closeMinor: 440, currency: EUR },
  ]);
  expect(result).toEqual({ written: 1, rejectedImplausible: 0, reBaselined: 0 });
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
  expect(result).toEqual({ written: 1, rejectedImplausible: 0, reBaselined: 0 });
});

test(`rejects a jump of more than ${MAX_PLAUSIBLE_RATIO}x, keeping the prior stored price`, () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  writePrices(db, instrument.id, "yahoo", [{ date: "2026-08-26", closeMinor: 400, currency: EUR }]);
  const result = writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-27", closeMinor: 400 * MAX_PLAUSIBLE_RATIO + 1, currency: EUR },
  ]);
  expect(result).toEqual({ written: 0, rejectedImplausible: 1, reBaselined: 0 });
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
  expect(result).toEqual({ written: 0, rejectedImplausible: 1, reBaselined: 0 });
});

test(`accepts a move of exactly ${MAX_PLAUSIBLE_RATIO}x -- the boundary is inclusive`, () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  writePrices(db, instrument.id, "yahoo", [{ date: "2026-08-26", closeMinor: 400, currency: EUR }]);
  const result = writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-27", closeMinor: 400 * MAX_PLAUSIBLE_RATIO, currency: EUR },
  ]);
  expect(result).toEqual({ written: 1, rejectedImplausible: 0, reBaselined: 0 });
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
  expect(result).toEqual({ written: 1, rejectedImplausible: 0, reBaselined: 0 });
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
  expect(result).toEqual({ written: 3, rejectedImplausible: 1, reBaselined: 0 });
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
    reBaselined: 0,
  });
});

// --- Self-healing re-baseline (Task 15 review fix) --------------------------
//
// Reviewer finding: comparing every new point only against the last
// *stored* price means a genuine permanent change (a steep split, a
// re-denomination) is rejected forever -- every later real price also
// fails against the same frozen stale baseline, and there is no
// price-correction UI anywhere in this app to unstick it by hand. The
// fix: a value repeated at a consistent new scale across
// RE_BASELINE_CONFIRMATIONS separate writePrices calls is trusted and
// becomes the new baseline. See write.ts's RE_BASELINE_CONFIRMATIONS doc
// comment for the full reasoning and why 3.

test("a one-off implausible value stays rejected -- it does not confirm on its own", () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  writePrices(db, instrument.id, "yahoo", [{ date: "2026-08-01", closeMinor: 400, currency: EUR }]);
  const result = writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-02", closeMinor: 4_400, currency: EUR },
  ]);
  expect(result).toEqual({ written: 0, rejectedImplausible: 1, reBaselined: 0 });
  expect(db.select().from(prices).all()).toHaveLength(1);
  const pending = db.select().from(pendingPriceRejections).all();
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ instrumentId: instrument.id, close: 4_400, streak: 1 });
});

test(`the same new scale confirmed ${RE_BASELINE_CONFIRMATIONS} times in a row is accepted and re-baselines`, () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  writePrices(db, instrument.id, "yahoo", [{ date: "2026-08-01", closeMinor: 400, currency: EUR }]);

  // Simulates a steep reverse split: every day from here on reports
  // ~4400-4500, a >10x jump from the old 400 baseline, but each new
  // reading is itself an ordinary day-to-day move relative to the last.
  const first = writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-02", closeMinor: 4_400, currency: EUR },
  ]);
  expect(first).toEqual({ written: 0, rejectedImplausible: 1, reBaselined: 0 });

  const second = writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-03", closeMinor: 4_450, currency: EUR },
  ]);
  expect(second).toEqual({ written: 0, rejectedImplausible: 1, reBaselined: 0 });
  expect(db.select().from(pendingPriceRejections).all()[0]).toMatchObject({
    close: 4_450,
    streak: 2,
  });

  const third = writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-04", closeMinor: 4_500, currency: EUR },
  ]);
  // The 3rd (RE_BASELINE_CONFIRMATIONS-th) consistent reading: accepted and re-baselined.
  expect(third).toEqual({ written: 1, rejectedImplausible: 0, reBaselined: 1 });

  const rows = db.select().from(prices).all();
  expect(rows).toHaveLength(2); // the original 2026-08-01 row, plus the re-baselined 2026-08-04 row.
  expect(rows.find((r) => r.date === "2026-08-04")).toMatchObject({ close: 4_500 });
  // The pending streak is fully resolved -- nothing left tracking it.
  expect(db.select().from(pendingPriceRejections).all()).toEqual([]);
});

test("a normal price after a re-baseline is compared against the new baseline, not the old one", () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  writePrices(db, instrument.id, "yahoo", [{ date: "2026-08-01", closeMinor: 400, currency: EUR }]);
  writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-02", closeMinor: 4_400, currency: EUR },
  ]);
  writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-03", closeMinor: 4_450, currency: EUR },
  ]);
  const reBaseline = writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-04", closeMinor: 4_500, currency: EUR },
  ]);
  expect(reBaseline.reBaselined).toBe(1);

  // An ordinary ~1% move relative to the new 4_500 baseline -- would have
  // been rejected outright as a >10x jump against the *original* 400
  // baseline, proving the comparison point actually moved.
  const after = writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-05", closeMinor: 4_550, currency: EUR },
  ]);
  expect(after).toEqual({ written: 1, rejectedImplausible: 0, reBaselined: 0 });
  expect(
    db
      .select()
      .from(prices)
      .all()
      .find((r) => r.date === "2026-08-05"),
  ).toMatchObject({
    close: 4_550,
  });
});

test("an unrelated second anomaly resets the confirmation streak instead of compounding with the first", () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  writePrices(db, instrument.id, "yahoo", [{ date: "2026-08-01", closeMinor: 400, currency: EUR }]);
  // First anomaly: a spurious ~11x spike.
  writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-02", closeMinor: 4_400, currency: EUR },
  ]);
  expect(db.select().from(pendingPriceRejections).all()[0]).toMatchObject({
    close: 4_400,
    streak: 1,
  });

  // Second anomaly: a completely different, unrelated implausible value
  // (not a continuation of the first spike) -- must restart the streak
  // at 1 with the new candidate, not become "streak 2" of the old one.
  // 30 is implausible vs. both: 400/30 > 10 (fails vs. the real baseline)
  // and 30 is nowhere near 4_400 either (fails vs. the pending candidate),
  // so this must start a brand new streak, not extend the old one.
  const unrelated = writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-03", closeMinor: 30, currency: EUR },
  ]);
  expect(unrelated).toEqual({ written: 0, rejectedImplausible: 1, reBaselined: 0 });
  expect(db.select().from(pendingPriceRejections).all()[0]).toMatchObject({ close: 30, streak: 1 });

  // Confirming the *second* anomaly twice more re-baselines to ITS scale, not the first's.
  writePrices(db, instrument.id, "yahoo", [{ date: "2026-08-04", closeMinor: 32, currency: EUR }]);
  const third = writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-05", closeMinor: 33, currency: EUR },
  ]);
  expect(third).toEqual({ written: 1, rejectedImplausible: 0, reBaselined: 1 });
  expect(
    db
      .select()
      .from(prices)
      .all()
      .find((r) => r.date === "2026-08-05"),
  ).toMatchObject({
    close: 33,
  });
});

test("a value that reverts to the original baseline's scale is accepted normally and clears the pending streak", () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  writePrices(db, instrument.id, "yahoo", [{ date: "2026-08-01", closeMinor: 400, currency: EUR }]);
  writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-02", closeMinor: 4_400, currency: EUR },
  ]);
  expect(db.select().from(pendingPriceRejections).all()).toHaveLength(1);

  // The anomaly was transient: the very next reading is back to normal
  // relative to the ORIGINAL stored baseline (400), not the spike.
  const recovered = writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-03", closeMinor: 410, currency: EUR },
  ]);
  expect(recovered).toEqual({ written: 1, rejectedImplausible: 0, reBaselined: 0 });
  expect(db.select().from(pendingPriceRejections).all()).toEqual([]);

  // A later value that repeats the original spike's exact scale starts a
  // brand new streak at 1, not a continuation of the abandoned one.
  const newAnomaly = writePrices(db, instrument.id, "yahoo", [
    { date: "2026-08-04", closeMinor: 4_400, currency: EUR },
  ]);
  expect(newAnomaly).toEqual({ written: 0, rejectedImplausible: 1, reBaselined: 0 });
  expect(db.select().from(pendingPriceRejections).all()[0]).toMatchObject({
    close: 4_400,
    streak: 1,
  });
});
