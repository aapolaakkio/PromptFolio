import { expect, test } from "bun:test";

import { EUR, parseCurrency } from "../../core/money";
import { testDb } from "../db";
import { accounts, instruments, priceFetchLog, prices, transactions, user } from "../db/schema";
import { backfillInstrument, refreshPrices, runScheduledRefresh, startScheduler } from "./refresh";

const SEK = parseCurrency("SEK");

type TestDb = ReturnType<typeof testDb>["db"];

const seedInstrument = (db: TestDb, over: Partial<typeof instruments.$inferInsert> = {}) =>
  db
    .insert(instruments)
    .values({
      isin: crypto.randomUUID(),
      ticker: "NOKIA.HE",
      name: "Nokia",
      kind: "stock",
      currency: EUR,
      priceSource: "yahoo",
      sourceKey: "NOKIA.HE",
      ...over,
    })
    .returning()
    .get();

/** Seeds a user + account + one transaction on `instrumentId`, dated `tradeDate`. */
const seedTransaction = (db: TestDb, args: { instrumentId: number; tradeDate: string }): void => {
  const userId = crypto.randomUUID();
  db.insert(user)
    .values({
      id: userId,
      name: "Testikäyttäjä",
      email: `${userId}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  const account = db
    .insert(accounts)
    .values({ userId, name: "Nordnet", broker: "nordnet", baseCurrency: EUR })
    .returning()
    .get();
  db.insert(transactions)
    .values({
      accountId: account.id,
      instrumentId: args.instrumentId,
      type: "BUY",
      tradeDate: args.tradeDate,
      currency: EUR,
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
    })
    .run();
};

const yahooStub = (closeUnits: number) => async (): Promise<Response> =>
  Response.json({
    chart: {
      result: [
        {
          meta: { currency: "EUR" },
          timestamp: [1787788800], // 2026-08-27T00:00:00Z
          indicators: { quote: [{ close: [closeUnits] }] },
        },
      ],
    },
  });

const mustNotBeCalled = (): Promise<Response> => {
  throw new Error("must not be called");
};

// --- refreshPrices -----------------------------------------------------------

test("writes one price row per instrument and logs success", async () => {
  const { db } = testDb();
  seedInstrument(db);
  const result = await refreshPrices(db, { fetchImpl: yahooStub(4.31), today: "2026-08-27" });
  expect(result).toEqual({ ok: 1, failed: 0 });
  expect(db.select().from(prices).all()[0]!.close).toBe(431);
  const log = db.select().from(priceFetchLog).all();
  expect(log).toHaveLength(1);
  expect(log[0]!.ok).toBe(true);
});

test("one failing source does not stop the others", async () => {
  const { db } = testDb();
  seedInstrument(db);
  seedInstrument(db, {
    isin: crypto.randomUUID(),
    name: "OP-Suomi A",
    kind: "fund",
    priceSource: "op_fund",
    sourceKey: "op-suomi-a",
    ticker: null,
  });
  const mixed = async (url: string | URL | Request): Promise<Response> =>
    String(url).includes("op.fi") ? new Response("down", { status: 503 }) : yahooStub(4.31)();

  const result = await refreshPrices(db, { fetchImpl: mixed, today: "2026-08-27" });
  expect(result).toEqual({ ok: 1, failed: 1 });
  const log = db.select().from(priceFetchLog).all();
  expect(log.filter((l) => !l.ok)[0]!.message).toContain("503");
});

test("skips manual instruments without logging a failure", async () => {
  const { db } = testDb();
  seedInstrument(db, { priceSource: "manual", sourceKey: "n/a" });
  const result = await refreshPrices(db, { fetchImpl: yahooStub(4.31), today: "2026-08-27" });
  expect(result).toEqual({ ok: 0, failed: 0 });
  expect(db.select().from(priceFetchLog).all()).toEqual([]);
});

test("re-running the same day overwrites rather than duplicating", async () => {
  const { db } = testDb();
  seedInstrument(db);
  await refreshPrices(db, { fetchImpl: yahooStub(4.31), today: "2026-08-27" });
  await refreshPrices(db, { fetchImpl: yahooStub(4.4), today: "2026-08-27" });
  const rows = db.select().from(prices).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.close).toBe(440);
});

test("reports spankki_fund/danske_fund as a distinct not-implemented failure, not a generic one", async () => {
  const { db } = testDb();
  seedInstrument(db, {
    isin: crypto.randomUUID(),
    name: "S-Pankki Kori",
    kind: "fund",
    priceSource: "spankki_fund",
    sourceKey: "x",
    ticker: null,
  });
  const result = await refreshPrices(db, { fetchImpl: mustNotBeCalled, today: "2026-08-27" });
  expect(result).toEqual({ ok: 0, failed: 1 });
  const log = db.select().from(priceFetchLog).all();
  expect(log[0]!.ok).toBe(false);
  expect(log[0]!.message).toContain("ei ole vielä toteutettu");
});

test("reports a large-jump rejection as a failure with a message distinct from a fetch error", async () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  db.insert(prices)
    .values({
      instrumentId: instrument.id,
      date: "2026-08-26",
      close: 400,
      currency: EUR,
      source: "yahoo",
      fetchedAt: new Date(),
    })
    .run();
  // 4310.00 EUR vs. a prior 4.00 EUR -- a >1000x jump, well past the plausible range.
  const result = await refreshPrices(db, { fetchImpl: yahooStub(4310), today: "2026-08-27" });
  expect(result).toEqual({ ok: 0, failed: 1 });
  const log = db.select().from(priceFetchLog).all();
  expect(log[0]!.ok).toBe(false);
  expect(log[0]!.message).toContain("epäuskottavana");
  // The stale 2026-08-26 price is exactly what's still stored -- no blank chart, no silently wrong total.
  const rows = db.select().from(prices).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.close).toBe(400);
});

test("a value confirmed across 3 daily refreshes is re-baselined, logged loudly, and counted ok", async () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  db.insert(prices)
    .values({
      instrumentId: instrument.id,
      date: "2026-08-01",
      close: 400,
      currency: EUR,
      source: "yahoo",
      fetchedAt: new Date(),
    })
    .run();

  // Simulates a steep reverse split, one scheduled weekday refresh at a
  // time: each day is a >10x jump from the original 400 baseline, but
  // consistent with the day before it.
  const first = await refreshPrices(db, { fetchImpl: yahooStub(44), today: "2026-08-02" });
  expect(first).toEqual({ ok: 0, failed: 1 });
  const second = await refreshPrices(db, { fetchImpl: yahooStub(44.5), today: "2026-08-03" });
  expect(second).toEqual({ ok: 0, failed: 1 });
  // Not yet in `prices` -- still pending confirmation.
  expect(db.select().from(prices).all()).toHaveLength(1);

  const third = await refreshPrices(db, { fetchImpl: yahooStub(45), today: "2026-08-04" });
  expect(third).toEqual({ ok: 1, failed: 0 });

  const log = db.select().from(priceFetchLog).all();
  const lastLog = log[log.length - 1]!;
  expect(lastLog.ok).toBe(true);
  expect(lastLog.message).toContain("UUDELLEENPERUSTETTU");

  const rows = db.select().from(prices).all();
  expect(rows).toHaveLength(2); // the original 2026-08-01 row, plus the re-baselined new one.
  expect(rows.find((r) => r.close === 4_500)).toBeDefined();
});

// --- backfillInstrument --------------------------------------------------------

test("backfills nothing and touches no network for an instrument with no transactions", async () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  const result = await backfillInstrument(db, instrument.id, { fetchImpl: mustNotBeCalled });
  expect(result).toEqual({ inserted: 0, incomplete: false });
});

test("backfills nothing and touches no network for a manual instrument", async () => {
  const { db } = testDb();
  const instrument = seedInstrument(db, { priceSource: "manual", sourceKey: "n/a" });
  seedTransaction(db, { instrumentId: instrument.id, tradeDate: "2020-01-01" });
  const result = await backfillInstrument(db, instrument.id, { fetchImpl: mustNotBeCalled });
  expect(result).toEqual({ inserted: 0, incomplete: false });
});

test("a source that covers the whole requested range backfills completely", async () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  seedTransaction(db, { instrumentId: instrument.id, tradeDate: "2026-08-20" });
  const fullHistory = async (): Promise<Response> =>
    Response.json({
      chart: {
        result: [
          {
            meta: { currency: "EUR" },
            // 2026-08-20, 21, 24, 27 (skipping the 22-23 weekend) -- covers
            // the whole requested range with no gap wider than a weekend.
            timestamp: [1787184000, 1787270400, 1787529600, 1787788800],
            indicators: { quote: [{ close: [4.1, 4.15, 4.2, 4.31] }] },
          },
        ],
      },
    });
  const result = await backfillInstrument(db, instrument.id, {
    fetchImpl: fullHistory,
    today: "2026-08-27",
  });
  expect(result).toEqual({ inserted: 4, incomplete: false });
  const log = db.select().from(priceFetchLog).all();
  expect(log[0]!.ok).toBe(true);
});

test("nordnet_fund's two-NAV-point limitation is reported as an incomplete backfill, not a silent success", async () => {
  const { db } = testDb();
  const instrument = seedInstrument(db, {
    isin: crypto.randomUUID(),
    name: "Nordnet Suomi Indeksi",
    kind: "fund",
    priceSource: "nordnet_fund",
    sourceKey: "nordnet-suomi-indeksi-eur-a401761d",
    ticker: null,
  });
  // A real holding's own transaction history goes back years; the public
  // page only ever has two recent NAV points (§10a A5).
  seedTransaction(db, { instrumentId: instrument.id, tradeDate: "2020-01-01" });

  const html = await Bun.file(`${import.meta.dir}/fixtures/nordnet-fund-suomi.html`).text();
  const result = await backfillInstrument(db, instrument.id, {
    fetchImpl: async () => new Response(html),
    today: "2026-08-27",
  });
  expect(result.inserted).toBe(2);
  expect(result.incomplete).toBe(true);

  const log = db.select().from(priceFetchLog).all();
  expect(log).toHaveLength(1);
  expect(log[0]!.ok).toBe(false);
  expect(log[0]!.message).toContain("jäi vajaaksi");
  expect(log[0]!.message).toContain("nordnet_fund");
});

test("a source throwing SourceNotImplementedError during backfill is reported as incomplete, not inserted", async () => {
  const { db } = testDb();
  const instrument = seedInstrument(db, {
    isin: crypto.randomUUID(),
    name: "S-Pankki Kori",
    kind: "fund",
    priceSource: "spankki_fund",
    sourceKey: "x",
    ticker: null,
  });
  seedTransaction(db, { instrumentId: instrument.id, tradeDate: "2020-01-01" });

  const result = await backfillInstrument(db, instrument.id, { fetchImpl: mustNotBeCalled });
  expect(result).toEqual({ inserted: 0, incomplete: true });
  const log = db.select().from(priceFetchLog).all();
  expect(log[0]!.message).toContain("ei ole vielä toteutettu");
});

test("a backfill batch that fully covers the range but contains one implausible point reports both", async () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  seedTransaction(db, { instrumentId: instrument.id, tradeDate: "2026-08-20" });
  const oneBadPoint = async (): Promise<Response> =>
    Response.json({
      chart: {
        result: [
          {
            meta: { currency: "EUR" },
            // 20th, 21st, 24th (implausible vs. 21st), 27th.
            timestamp: [1787184000, 1787270400, 1787529600, 1787788800],
            indicators: { quote: [{ close: [4.1, 4.15, 4.15 * 1000, 4.3] }] },
          },
        ],
      },
    });
  const result = await backfillInstrument(db, instrument.id, {
    fetchImpl: oneBadPoint,
    today: "2026-08-27",
  });
  expect(result).toEqual({ inserted: 3, incomplete: false });
  const log = db.select().from(priceFetchLog).all();
  expect(log).toHaveLength(1);
  expect(log[0]!.ok).toBe(false);
  expect(log[0]!.message).toContain("hylätty epäuskottavana hintahyppynä");
  expect(log[0]!.message).not.toContain("jäi vajaaksi");
});

test("a re-baseline confirmed within one backfill batch is logged loudly and counted ok despite the leftover rejections", async () => {
  const { db } = testDb();
  const instrument = seedInstrument(db);
  seedTransaction(db, { instrumentId: instrument.id, tradeDate: "2026-08-01" });
  const reverseSplitMidHistory = async (): Promise<Response> =>
    Response.json({
      chart: {
        result: [
          {
            meta: { currency: "EUR" },
            // 08-01 (normal), 08-02/03 (implausible vs. 08-01, pending),
            // 08-04 (3rd consistent reading -> confirmed re-baseline),
            // 08-05 (an ordinary move vs. the NEW baseline).
            timestamp: [1785542400, 1785628800, 1785715200, 1785801600, 1785888000],
            indicators: { quote: [{ close: [4, 44, 44.5, 45, 45.5] }] },
          },
        ],
      },
    });
  const result = await backfillInstrument(db, instrument.id, {
    fetchImpl: reverseSplitMidHistory,
    today: "2026-08-05",
  });
  // 08-01, 08-04 (the confirmed re-baseline) and 08-05 are written; 08-02
  // and 08-03 are the two consumed-as-confirmation rejections.
  expect(result).toEqual({ inserted: 3, incomplete: false });

  const log = db.select().from(priceFetchLog).all();
  expect(log).toHaveLength(1);
  expect(log[0]!.ok).toBe(true);
  expect(log[0]!.message).toContain("UUDELLEENPERUSTETTU");
  expect(log[0]!.message).toContain("hylätty epäuskottavana hintahyppynä");
  expect(log[0]!.message).not.toContain("jäi vajaaksi");

  const rows = db
    .select()
    .from(prices)
    .all()
    .map((r) => ({ date: r.date, close: r.close }));
  expect(rows).toContainEqual({ date: "2026-08-01", close: 400 });
  expect(rows).toContainEqual({ date: "2026-08-04", close: 4_500 });
  expect(rows).toContainEqual({ date: "2026-08-05", close: 4_550 });
  expect(rows).toHaveLength(3);
});

// --- runScheduledRefresh / startScheduler --------------------------------------

test("runScheduledRefresh never rejects, even when the FX fetch fails", async () => {
  const { db } = testDb();
  // A held non-EUR currency forces refreshFxRates to actually attempt a
  // fetch; no fetchImpl is passed to runScheduledRefresh (matching how
  // Bun.cron itself would call it), so this hits the real global fetch --
  // which src/server/test-network-guard.ts replaces with one that always
  // throws. This exercises exactly the failure this function exists to
  // survive: an outer try/catch that must never let a rejection through.
  seedCurrencyOnlyTransaction(db, SEK);
  await expect(runScheduledRefresh(db)).resolves.toBeUndefined();
});

test("runScheduledRefresh completes normally against an empty ledger and no instruments", async () => {
  const { db } = testDb();
  await expect(runScheduledRefresh(db)).resolves.toBeUndefined();
});

test("startScheduler rejects a syntactically invalid schedule instead of registering it silently", () => {
  const { db } = testDb();
  expect(() => startScheduler(db, { schedule: "not a cron expression", tz: "UTC" })).toThrow(
    /Ajastuslauseke/,
  );
});

test("startScheduler rejects a schedule with no future occurrence (Bun.cron.parse returns null)", () => {
  const { db } = testDb();
  expect(() => startScheduler(db, { schedule: "0 0 30 2 *", tz: "UTC" })).toThrow(/Ajastuslauseke/);
});

test("startScheduler registers a real, verified-parseable schedule and returns a stoppable job", () => {
  const { db } = testDb();
  // Far enough in the future (relative to this fixture's 2026-08-27
  // "today") that it cannot fire during this test run.
  const job = startScheduler(db, { schedule: "0 3 1 1 *", tz: "UTC" });
  expect(job.cron).toBe("0 3 1 1 *");
  job.stop();
});

/** Seeds one ledger transaction in `currency`, with the user/account it needs to satisfy FKs, and no instrument. */
function seedCurrencyOnlyTransaction(db: TestDb, currency: typeof SEK): void {
  const userId = crypto.randomUUID();
  db.insert(user)
    .values({
      id: userId,
      name: "Testikäyttäjä",
      email: `${userId}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  const account = db
    .insert(accounts)
    .values({ userId, name: "Nordnet", broker: "nordnet", baseCurrency: EUR })
    .returning()
    .get();
  db.insert(transactions)
    .values({
      accountId: account.id,
      type: "DEPOSIT",
      tradeDate: "2026-01-01",
      currency,
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
    })
    .run();
}
