import { readText } from "../files.ts";
import { urlOf } from "./types.ts";
import { expect, test } from "vitest";
import { asc, eq } from "drizzle-orm";

import { EUR, parseCurrency } from "../../core/money.ts";
import { testDb } from "../db/test-db.ts";
import {
  accounts,
  instruments,
  priceFetchLog,
  prices,
  transactions,
  user,
  yahooGate,
} from "../db/schema.ts";
import { backfillInstrument, backfillMany, refreshPrices, runScheduledRefresh } from "./refresh.ts";
import { YahooPausedError } from "./yahoo-gate.ts";

const SEK = parseCurrency("SEK");

type TestDb = Awaited<ReturnType<typeof testDb>>["db"];

const seedInstrument = async (db: TestDb, over: Partial<typeof instruments.$inferInsert> = {}) =>
  await db
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

/**
 * Seeds a user + account + one BUY transaction on `instrumentId`, dated `tradeDate`, and
 * returns the ids it created. `quantity`/`amount` default to 0 (this file's original
 * behaviour, still what most callers here want -- they only care about the transaction's
 * *date*, to give backfill an earliest transaction to backfill against); pass a real
 * `quantity` when a test also needs `positionsAt`/`valueSeries` to see a non-zero holding.
 */
const seedTransaction = async (
  db: TestDb,
  args: { instrumentId: number; tradeDate: string; quantity?: number; amount?: number },
) => {
  const userId = crypto.randomUUID();
  await db
    .insert(user)
    .values({
      id: userId,
      name: "Testikäyttäjä",
      email: `${userId}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  const account = await db
    .insert(accounts)
    .values({ userId, name: "Nordnet", broker: "nordnet", baseCurrency: EUR })
    .returning()
    .get();
  if (account === undefined) throw new Error("account insert returned nothing");
  await db
    .insert(transactions)
    .values({
      accountId: account.id,
      instrumentId: args.instrumentId,
      type: "BUY",
      tradeDate: args.tradeDate,
      quantity: args.quantity ?? 0,
      amount: args.amount ?? 0,
      currency: EUR,
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
    })
    .run();
  return { userId, accountId: account.id };
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

const mustNotBeCalled = async (): Promise<Response> => {
  throw new Error("must not be called");
};

/** An instrument someone holds: refreshPrices skips one nobody does. */
const seedHeld = async (db: TestDb, over: Partial<typeof instruments.$inferInsert> = {}) => {
  const instrument = await seedInstrument(db, over);
  await seedTransaction(db, {
    instrumentId: instrument.id,
    tradeDate: "2026-01-02",
    quantity: 1_000_000,
  });
  return instrument;
};

const pauseYahoo = async (db: TestDb): Promise<void> => {
  await db
    .insert(yahooGate)
    .values({ id: 1, pausedUntil: Date.now() + 60 * 60_000, backoffMs: 15 * 60_000 })
    .run();
};

// --- refreshPrices -----------------------------------------------------------

test("writes one price row per instrument and logs success", async () => {
  const { db } = await testDb();
  await seedHeld(db);
  const result = await refreshPrices(db, {
    yahooSpacingMs: 0,
    fetchImpl: yahooStub(4.31),
    today: "2026-08-27",
  });
  expect(result).toEqual({ ok: 1, failed: 0, paused: false });
  expect((await db.select().from(prices).all())[0]!.close).toBe(431);
  const log = await db.select().from(priceFetchLog).all();
  expect(log).toHaveLength(1);
  expect(log[0]!.ok).toBe(true);
});

test("one failing source does not stop the others", async () => {
  const { db } = await testDb();
  await seedHeld(db);
  await seedHeld(db, {
    isin: crypto.randomUUID(),
    name: "OP-Suomi A",
    kind: "fund",
    priceSource: "op_fund",
    sourceKey: "op-suomi-a",
    ticker: null,
  });
  const mixed = async (url: string | URL | Request): Promise<Response> =>
    urlOf(url).includes("op.fi") ? new Response("down", { status: 503 }) : yahooStub(4.31)();

  const result = await refreshPrices(db, {
    yahooSpacingMs: 0,
    fetchImpl: mixed,
    today: "2026-08-27",
  });
  expect(result).toEqual({ ok: 1, failed: 1, paused: false });
  const log = await db.select().from(priceFetchLog).all();
  expect(log.filter((l) => !l.ok)[0]!.message).toContain("503");
});

test("stores a fund's latest value, which is always dated before the day it is fetched", async () => {
  // OP's page on a Monday shows Friday's NAV. Asking for today alone dropped
  // it, so a fund never got a price from the daily refresh at all.
  const { db } = await testDb();
  const fund = await seedHeld(db, {
    isin: crypto.randomUUID(),
    name: "OP-Maailma Indeksi A",
    kind: "fund",
    priceSource: "op_fund",
    sourceKey: "op-maailma-indeksi",
    ticker: null,
  });
  const page = "<dl><dt>Osuuden arvo (21.08.)</dt><dd>283,60 EUR</dd></dl>";

  const result = await refreshPrices(db, {
    fetchImpl: async () => new Response(page),
    today: "2026-08-24",
  });

  expect(result).toEqual({ ok: 1, failed: 0, paused: false });
  const stored = await db.select().from(prices).where(eq(prices.instrumentId, fund.id)).all();
  expect(stored.map((p) => [p.date, p.close])).toEqual([["2026-08-21", 28360]]);
});

test("skips manual instruments without logging a failure", async () => {
  const { db } = await testDb();
  await seedHeld(db, { priceSource: "manual", sourceKey: "n/a" });
  const result = await refreshPrices(db, {
    yahooSpacingMs: 0,
    fetchImpl: yahooStub(4.31),
    today: "2026-08-27",
  });
  expect(result).toEqual({ ok: 0, failed: 0, paused: false });
  expect(await db.select().from(priceFetchLog).all()).toEqual([]);
});

test("re-running the same day overwrites rather than duplicating", async () => {
  const { db } = await testDb();
  await seedHeld(db);
  await refreshPrices(db, { yahooSpacingMs: 0, fetchImpl: yahooStub(4.31), today: "2026-08-27" });
  await refreshPrices(db, { yahooSpacingMs: 0, fetchImpl: yahooStub(4.4), today: "2026-08-27" });
  const rows = await db.select().from(prices).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.close).toBe(440);
});

test("reports a large-jump rejection as a failure with a message distinct from a fetch error", async () => {
  const { db } = await testDb();
  const instrument = await seedHeld(db);
  await db
    .insert(prices)
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
  const result = await refreshPrices(db, {
    yahooSpacingMs: 0,
    fetchImpl: yahooStub(4310),
    today: "2026-08-27",
  });
  expect(result).toEqual({ ok: 0, failed: 1, paused: false });
  const log = await db.select().from(priceFetchLog).all();
  expect(log[0]!.ok).toBe(false);
  expect(log[0]!.message).toContain("epäuskottavana");
  // The stale 2026-08-26 price is exactly what's still stored -- no blank chart, no silently wrong total.
  const rows = await db.select().from(prices).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.close).toBe(400);
});

test("a value confirmed across 3 daily refreshes is re-baselined, logged loudly, and counted ok", async () => {
  const { db } = await testDb();
  const instrument = await seedHeld(db);
  await db
    .insert(prices)
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
  const first = await refreshPrices(db, {
    yahooSpacingMs: 0,
    fetchImpl: yahooStub(44),
    today: "2026-08-02",
  });
  expect(first).toEqual({ ok: 0, failed: 1, paused: false });
  const second = await refreshPrices(db, {
    yahooSpacingMs: 0,
    fetchImpl: yahooStub(44.5),
    today: "2026-08-03",
  });
  expect(second).toEqual({ ok: 0, failed: 1, paused: false });
  // Not yet in `prices` -- still pending confirmation.
  expect(await db.select().from(prices).all()).toHaveLength(1);

  const third = await refreshPrices(db, {
    yahooSpacingMs: 0,
    fetchImpl: yahooStub(45),
    today: "2026-08-04",
  });
  expect(third).toEqual({ ok: 1, failed: 0, paused: false });

  const log = await db.select().from(priceFetchLog).all();
  const lastLog = log[log.length - 1]!;
  expect(lastLog.ok).toBe(true);
  expect(lastLog.message).toContain("UUDELLEENPERUSTETTU");

  const rows = await db.select().from(prices).all();
  expect(rows).toHaveLength(2); // the original 2026-08-01 row, plus the re-baselined new one.
  expect(rows.find((r) => r.close === 4_500)).toBeDefined();
});

test("asks Yahoo once per held listing, in one run, and once for a symbol held twice", async () => {
  const { db } = await testDb();
  await seedHeld(db);
  await seedHeld(db, { isin: crypto.randomUUID(), ticker: "SAP.DE", sourceKey: "SAP.DE" });
  await seedHeld(db, { isin: crypto.randomUUID(), sourceKey: "NOKIA.HE" });
  const urls: string[] = [];
  const recording = async (input: string | URL | Request): Promise<Response> => {
    urls.push(urlOf(input));
    return yahooStub(4.31)();
  };

  const result = await refreshPrices(db, {
    yahooSpacingMs: 0,
    fetchImpl: recording,
    today: "2026-08-27",
  });

  expect(result).toEqual({ ok: 3, failed: 0, paused: false });
  expect(urls.filter((url) => url.includes("chart/NOKIA.HE"))).toHaveLength(1);
  expect(urls.filter((url) => url.includes("chart/SAP.DE"))).toHaveLength(1);
});

test("an instrument nobody holds is not asked for", async () => {
  const { db } = await testDb();
  await seedInstrument(db);
  const result = await refreshPrices(db, {
    yahooSpacingMs: 0,
    fetchImpl: mustNotBeCalled,
    today: "2026-08-27",
  });
  expect(result).toEqual({ ok: 0, failed: 0, paused: false });
});

test("a paused Yahoo asks nothing of it, logs nothing for it, and still refreshes funds", async () => {
  const { db } = await testDb();
  await seedHeld(db);
  await seedHeld(db, {
    isin: crypto.randomUUID(),
    name: "OP-Maailma Indeksi A",
    kind: "fund",
    priceSource: "op_fund",
    sourceKey: "op-maailma-indeksi",
    ticker: null,
  });
  await pauseYahoo(db);
  const page = "<dl><dt>Osuuden arvo (21.08.)</dt><dd>283,60 EUR</dd></dl>";
  const onlyOp = async (input: string | URL | Request): Promise<Response> => {
    if (urlOf(input).includes("yahoo")) throw new Error("Yahoo must not be asked");
    return new Response(page);
  };

  const result = await refreshPrices(db, {
    yahooSpacingMs: 0,
    fetchImpl: onlyOp,
    today: "2026-08-24",
  });

  expect(result).toEqual({ ok: 1, failed: 0, paused: true });
  const log = await db.select().from(priceFetchLog).all();
  expect(log.map((row) => row.source)).toEqual(["op_fund"]);
});

test("a 429 mid-run keeps the quotes already fetched and asks no more", async () => {
  const { db } = await testDb();
  await seedHeld(db);
  await seedHeld(db, { isin: crypto.randomUUID(), ticker: "SAP.DE", sourceKey: "SAP.DE" });
  await seedHeld(db, { isin: crypto.randomUUID(), ticker: "KCR.HE", sourceKey: "KCR.HE" });
  const calls = { count: 0 };
  const secondIs429 = async (): Promise<Response> => {
    calls.count += 1;
    return calls.count === 1 ? yahooStub(4.31)() : new Response("", { status: 429 });
  };

  const result = await refreshPrices(db, {
    yahooSpacingMs: 0,
    fetchImpl: secondIs429,
    today: "2026-08-27",
  });

  expect(result).toEqual({ ok: 1, failed: 0, paused: true });
  expect(calls.count).toBe(2);
  expect(await db.select().from(prices).all()).toHaveLength(1);
});

// --- backfillInstrument --------------------------------------------------------

test("backfills nothing and touches no network for an instrument with no transactions", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  const result = await backfillInstrument(db, instrument.id, { fetchImpl: mustNotBeCalled });
  expect(result).toEqual({ inserted: 0, incomplete: false });
});

test("backfills nothing and touches no network for a manual instrument", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db, { priceSource: "manual", sourceKey: "n/a" });
  await seedTransaction(db, { instrumentId: instrument.id, tradeDate: "2020-01-01" });
  const result = await backfillInstrument(db, instrument.id, { fetchImpl: mustNotBeCalled });
  expect(result).toEqual({ inserted: 0, incomplete: false });
});

test("a source that covers the whole requested range backfills completely", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  await seedTransaction(db, { instrumentId: instrument.id, tradeDate: "2026-08-20" });
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
  const log = await db.select().from(priceFetchLog).all();
  expect(log[0]!.ok).toBe(true);
});

test("nordnet_fund's two-NAV-point limitation is reported as an incomplete backfill, not a silent success", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db, {
    isin: crypto.randomUUID(),
    name: "Nordnet Suomi Indeksi",
    kind: "fund",
    priceSource: "nordnet_fund",
    sourceKey: "nordnet-suomi-indeksi-eur-a401761d",
    ticker: null,
  });
  // A real holding's own transaction history goes back years; the public
  // page only ever has two recent NAV points (§10a A5).
  await seedTransaction(db, { instrumentId: instrument.id, tradeDate: "2020-01-01" });

  const html = await readText(`${import.meta.dirname}/fixtures/nordnet-fund-suomi.html`);
  const result = await backfillInstrument(db, instrument.id, {
    fetchImpl: async () => new Response(html),
    today: "2026-08-27",
  });
  expect(result.inserted).toBe(2);
  expect(result.incomplete).toBe(true);

  const log = await db.select().from(priceFetchLog).all();
  expect(log).toHaveLength(1);
  expect(log[0]!.ok).toBe(false);
  expect(log[0]!.message).toContain("jäi vajaaksi");
  expect(log[0]!.message).toContain("nordnet_fund");
});

test("a source that throws during backfill is reported as incomplete, not partially inserted", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  await seedTransaction(db, { instrumentId: instrument.id, tradeDate: "2020-01-01" });

  const throwingFetch = async (): Promise<Response> => {
    throw new Error("verkkovirhe");
  };
  const result = await backfillInstrument(db, instrument.id, { fetchImpl: throwingFetch });
  expect(result).toEqual({ inserted: 0, incomplete: true });
  const log = await db.select().from(priceFetchLog).all();
  expect(log[0]!.ok).toBe(false);
  expect(log[0]!.message).toContain("verkkovirhe");
});

test("a backfill batch that fully covers the range but contains one implausible point reports both", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  await seedTransaction(db, { instrumentId: instrument.id, tradeDate: "2026-08-20" });
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
  const log = await db.select().from(priceFetchLog).all();
  expect(log).toHaveLength(1);
  expect(log[0]!.ok).toBe(false);
  expect(log[0]!.message).toContain("hylätty epäuskottavana hintahyppynä");
  expect(log[0]!.message).not.toContain("jäi vajaaksi");
});

test("a re-baseline confirmed within one backfill batch is logged loudly and counted ok despite the leftover rejections", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  await seedTransaction(db, { instrumentId: instrument.id, tradeDate: "2026-08-01" });
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

  const log = await db.select().from(priceFetchLog).all();
  expect(log).toHaveLength(1);
  expect(log[0]!.ok).toBe(true);
  expect(log[0]!.message).toContain("UUDELLEENPERUSTETTU");
  expect(log[0]!.message).toContain("hylätty epäuskottavana hintahyppynä");
  expect(log[0]!.message).not.toContain("jäi vajaaksi");

  const rows = (await db.select().from(prices).all()).map((r) => ({
    date: r.date,
    close: r.close,
  }));
  expect(rows).toContainEqual({ date: "2026-08-01", close: 400 });
  expect(rows).toContainEqual({ date: "2026-08-04", close: 4_500 });
  expect(rows).toContainEqual({ date: "2026-08-05", close: 4_550 });
  expect(rows).toHaveLength(3);
});

// --- backfillMany / needsBackfill (the nightly catch-up sweep's selection) ----

/** A fetchImpl covering the whole 2026-08-20..27 range with no gap wider than a weekend. */
const fullHistoryAug20to27 = async (): Promise<Response> =>
  Response.json({
    chart: {
      result: [
        {
          meta: { currency: "EUR" },
          timestamp: [1787184000, 1787270400, 1787529600, 1787788800],
          indicators: { quote: [{ close: [4.1, 4.15, 4.2, 4.31] }] },
        },
      ],
    },
  });

test("backfillMany skips an instrument whose stored history already reaches its earliest transaction", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  await seedTransaction(db, { instrumentId: instrument.id, tradeDate: "2026-08-20" });
  await db
    .insert(prices)
    .values({
      instrumentId: instrument.id,
      date: "2026-08-20",
      close: 410,
      currency: EUR,
      source: "yahoo",
      fetchedAt: new Date(),
    })
    .run();

  const result = await backfillMany(db, [instrument.id], { fetchImpl: mustNotBeCalled });
  expect(result).toEqual({ attempted: 0, backfilled: 0, incomplete: 0, errored: 0 });
});

test("backfillMany never retries nordnet_fund or op_fund -- neither can ever return real history, only their latest point(s)", async () => {
  const { db } = await testDb();
  const nordnet = await seedInstrument(db, {
    isin: crypto.randomUUID(),
    name: "Nordnet Suomi Indeksi",
    kind: "fund",
    priceSource: "nordnet_fund",
    sourceKey: "nordnet-suomi-indeksi-eur-a401761d",
    ticker: null,
  });
  await seedTransaction(db, { instrumentId: nordnet.id, tradeDate: "2020-01-01" });

  const opFund = await seedInstrument(db, {
    isin: crypto.randomUUID(),
    name: "OP-Maailma Indeksi",
    kind: "fund",
    priceSource: "op_fund",
    sourceKey: "op-maailma-indeksi",
    ticker: null,
  });
  await seedTransaction(db, { instrumentId: opFund.id, tradeDate: "2020-01-01" });

  const result = await backfillMany(db, [nordnet.id, opFund.id], { fetchImpl: mustNotBeCalled });
  expect(result).toEqual({ attempted: 0, backfilled: 0, incomplete: 0, errored: 0 });
});

test("backfillMany backfills an instrument with no stored history at all, and a re-run afterwards is a no-op", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  await seedTransaction(db, { instrumentId: instrument.id, tradeDate: "2026-08-20" });

  const first = await backfillMany(db, [instrument.id], {
    fetchImpl: fullHistoryAug20to27,
    today: "2026-08-27",
  });
  expect(first).toEqual({ attempted: 1, backfilled: 1, incomplete: 0, errored: 0 });

  const second = await backfillMany(db, [instrument.id], {
    fetchImpl: mustNotBeCalled,
    today: "2026-08-27",
  });
  expect(second).toEqual({ attempted: 0, backfilled: 0, incomplete: 0, errored: 0 });
});

test("backfillMany aggregates a mixed batch: one instrument backfills, one is skipped as never-backfillable", async () => {
  const { db } = await testDb();
  const stock = await seedInstrument(db);
  await seedTransaction(db, { instrumentId: stock.id, tradeDate: "2026-08-20" });

  const nordnet = await seedInstrument(db, {
    isin: crypto.randomUUID(),
    name: "Nordnet Suomi Indeksi",
    kind: "fund",
    priceSource: "nordnet_fund",
    sourceKey: "nordnet-suomi-indeksi-eur-a401761d",
    ticker: null,
  });
  await seedTransaction(db, { instrumentId: nordnet.id, tradeDate: "2020-01-01" });

  const result = await backfillMany(db, [stock.id, nordnet.id], {
    fetchImpl: fullHistoryAug20to27,
    today: "2026-08-27",
  });
  expect(result).toEqual({ attempted: 1, backfilled: 1, incomplete: 0, errored: 0 });
});

test("backfill through a paused gate makes no request and logs nothing", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  await seedTransaction(db, { instrumentId: instrument.id, tradeDate: "2020-01-01" });
  await pauseYahoo(db);
  await expect(
    backfillInstrument(db, instrument.id, { fetchImpl: mustNotBeCalled }),
  ).rejects.toThrow(YahooPausedError);
  expect(await db.select().from(priceFetchLog).all()).toEqual([]);
});

test("backfillMany stops asking Yahoo after a 429 but still backfills other sources", async () => {
  const { db } = await testDb();
  const first = await seedInstrument(db);
  await seedTransaction(db, { instrumentId: first.id, tradeDate: "2026-08-20" });
  const second = await seedInstrument(db, { isin: crypto.randomUUID(), sourceKey: "SAP.DE" });
  await seedTransaction(db, { instrumentId: second.id, tradeDate: "2026-08-20" });
  const calls = { count: 0 };
  const always429 = async (): Promise<Response> => {
    calls.count += 1;
    return new Response("", { status: 429 });
  };

  const result = await backfillMany(db, [first.id, second.id], {
    fetchImpl: always429,
    today: "2026-08-27",
  });

  expect(result).toEqual({ attempted: 0, backfilled: 0, incomplete: 0, errored: 0 });
  expect(calls.count).toBe(1);
});

// --- end-to-end: backfill closes the empty-history gap -------------------------

test("an instrument with a years-old transaction ends up with price rows spanning that range, and its value series is no longer all zeros", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db, {
    isin: crypto.randomUUID(),
    ticker: "IWDA.AS",
    name: "iShares Core MSCI World UCITS ETF",
    kind: "etf",
    sourceKey: "IWDA.AS",
  });
  // 10 units bought 2020-06-15 -- a real multi-year-old holding, exactly the
  // gap the README used to blame on Nordnet alone (task brief: it applies to
  // yahoo-priced instruments too).
  const { userId } = await seedTransaction(db, {
    instrumentId: instrument.id,
    tradeDate: "2020-06-15",
    quantity: 10_000_000, // 10.000000 units, scaled 1e6 (core/money.ts QUANTITY_SCALE)
    amount: -3_000_00, // 30.00 EUR, minor units, signed negative (cash left the account)
  });

  const yearsOfHistory = async (): Promise<Response> =>
    Response.json({
      chart: {
        result: [
          {
            meta: { currency: "EUR" },
            // 2020-06-15 (the purchase date itself), 2023-06-15, 2026-08-20, 2026-08-27 (today).
            timestamp: [1592179200, 1686787200, 1787184000, 1787788800],
            indicators: { quote: [{ close: [3.0, 4.5, 5.2, 5.3] }] },
          },
        ],
      },
    });

  const result = await backfillInstrument(db, instrument.id, {
    fetchImpl: yearsOfHistory,
    today: "2026-08-27",
  });
  expect(result).toEqual({ inserted: 4, incomplete: false });

  const priceRows = await db
    .select({ date: prices.date, close: prices.close })
    .from(prices)
    .where(eq(prices.instrumentId, instrument.id))
    .orderBy(asc(prices.date))
    .all();
  expect(priceRows).toEqual([
    { date: "2020-06-15", close: 300 },
    { date: "2023-06-15", close: 450 },
    { date: "2026-08-20", close: 520 },
    { date: "2026-08-27", close: 530 },
  ]);

  // Before backfill, `valueSeries` over this range would have been all zeros (no
  // price existed before this ran): every day fell back to "no price known",
  // excluding the instrument entirely (core/returns.ts's `excludedInstrumentIds`).
  // Loading through valuation.ts's `loadPortfolio` -- the same path
  // /api/value-series uses -- proves this is no longer true, end to end, through
  // a real `PriceLookup`, not a hand-built stub of one.
  const { loadPortfolio } = await import("../valuation.ts");
  const { valueSeries } = await import("../../core/returns.ts");
  const {
    txns,
    instruments: portfolioInstruments,
    prices: priceLookup,
  } = await loadPortfolio(db, userId);
  const series = valueSeries(txns, portfolioInstruments, priceLookup, "2020-06-14", "2026-08-27");

  // The day before the purchase: no position yet, correctly zero.
  expect(series.find((p) => p.date === "2020-06-14")?.valueEur.minor).toBe(0n);
  // The purchase date itself: 10 units at the backfilled 3.00 EUR close = 30.00 EUR.
  const onPurchase = series.find((p) => p.date === "2020-06-15");
  expect(onPurchase?.valueEur).toEqual({ minor: 3_000n, currency: EUR });
  expect(onPurchase?.stale).toBe(false);
  expect(onPurchase?.excludedInstrumentIds).toEqual([]);
  // Mid-history, on a date backfill actually supplied a price for: 10 units at
  // the backfilled 4.50 EUR close = 45.00 EUR -- real historical data, not a
  // carried-forward placeholder and not an implied 0,00 €.
  const midHistory = series.find((p) => p.date === "2023-06-15");
  expect(midHistory?.valueEur).toEqual({ minor: 4_500n, currency: EUR });
  expect(midHistory?.stale).toBe(false);
  // Today: 10 units at 5.30 EUR = 53.00 EUR.
  const today = series.find((p) => p.date === "2026-08-27");
  expect(today?.valueEur).toEqual({ minor: 5_300n, currency: EUR });

  // The headline claim: this range is not all zeros any more.
  const nonZeroDays = series.filter((p) => p.valueEur.minor > 0n);
  expect(nonZeroDays.length).toBeGreaterThan(0);
});

// --- runScheduledRefresh ---

test("runScheduledRefresh never rejects, even when the FX fetch fails", async () => {
  const { db } = await testDb();
  // A held non-EUR currency forces refreshFxRates to actually attempt a
  // fetch; no fetchImpl is passed to runScheduledRefresh (matching how
  // the scheduler itself would call it), so this hits the real global fetch --
  // which src/server/test-network-guard.ts replaces with one that always
  // throws. This exercises exactly the failure this function exists to
  // survive: an outer try/catch that must never let a rejection through.
  await seedCurrencyOnlyTransaction(db, SEK);
  await expect(runScheduledRefresh(db)).resolves.toBeUndefined();
});

test("runScheduledRefresh completes normally against an empty ledger and no instruments", async () => {
  const { db } = await testDb();
  await expect(runScheduledRefresh(db)).resolves.toBeUndefined();
});

test("runScheduledRefresh's nightly catch-up sweep attempts backfill for an instrument whose history doesn't reach its earliest transaction, and still never rejects when that fetch fails", async () => {
  const { db } = await testDb();
  const instrument = await seedInstrument(db);
  await seedTransaction(db, { instrumentId: instrument.id, tradeDate: "2020-01-01" });

  // No fetchImpl passed to runScheduledRefresh (matching the scheduler's real call, and the
  // existing "never rejects" test above) -- this reaches the real global fetch, which
  // test-network-guard.ts replaces with one that always throws. Proves two things at
  // once: the catch-up sweep really did attempt a network call for this instrument
  // (not silently skip it), and a failing one still can't take the scheduled job down.
  await expect(runScheduledRefresh(db)).resolves.toBeUndefined();

  const log = await db
    .select()
    .from(priceFetchLog)
    .where(eq(priceFetchLog.instrumentId, instrument.id))
    .all();
  const backfillAttempt = log.find((row) => row.message?.includes("Taustatäyttö epäonnistui"));
  expect(backfillAttempt).toBeDefined();
  expect(backfillAttempt?.ok).toBe(false);
});

/** Seeds one ledger transaction in `currency`, with the user/account it needs to satisfy FKs, and no instrument. */
async function seedCurrencyOnlyTransaction(db: TestDb, currency: typeof SEK): Promise<void> {
  const userId = crypto.randomUUID();
  await db
    .insert(user)
    .values({
      id: userId,
      name: "Testikäyttäjä",
      email: `${userId}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  const account = await db
    .insert(accounts)
    .values({ userId, name: "Nordnet", broker: "nordnet", baseCurrency: EUR })
    .returning()
    .get();
  if (account === undefined) throw new Error("account insert returned nothing");
  await db
    .insert(transactions)
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

test("refreshPrices spaces page fetches and still runs Yahoo", async () => {
  const { db } = await testDb();
  await seedHeld(db);
  for (const slug of ["a", "b"]) {
    await seedHeld(db, {
      isin: crypto.randomUUID(),
      name: `Sivurahasto ${slug}`,
      kind: "fund",
      priceSource: "page",
      sourceKey: `https://example.test/${slug}`,
      ticker: null,
    });
  }
  const pageAt: number[] = [];
  const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
    if (urlOf(url).includes("example.test")) {
      pageAt.push(Date.now());
      return new Response("<p>ei mitään</p>");
    }
    return yahooStub(4.31)();
  };

  const result = await refreshPrices(db, {
    yahooSpacingMs: 0,
    pageSpacingMs: 40,
    fetchImpl,
    today: "2026-08-27",
  });

  expect(result).toEqual({ ok: 1, failed: 2, paused: false });
  expect(pageAt).toHaveLength(2);
  expect(pageAt[1]! - pageAt[0]!).toBeGreaterThanOrEqual(35);
});

test("a direct backfill of a page instrument does not throw and writes nothing", async () => {
  const { db } = await testDb();
  const fund = await seedHeld(db, {
    kind: "fund",
    priceSource: "page",
    sourceKey: "https://example.test/x",
    ticker: null,
  });
  const result = await backfillInstrument(db, fund.id, { fetchImpl: mustNotBeCalled });
  expect(result).toEqual({ inserted: 0, incomplete: false });
  expect(await backfillMany(db, [fund.id], { fetchImpl: mustNotBeCalled })).toMatchObject({
    attempted: 0,
  });
});
