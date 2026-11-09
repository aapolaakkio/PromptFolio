import { expect, test } from "vitest";

import { EUR } from "../../core/money.ts";
import { testDb } from "../db/test-db.ts";
import { accounts, instruments, prices, transactions, user, yahooGate } from "../db/schema.ts";
import { heldInstrumentIds, refreshIntraday } from "./intraday.ts";
import { urlOf, type FetchImpl } from "./types.ts";

type TestDb = Awaited<ReturnType<typeof testDb>>["db"];

// A Wednesday: Helsinki 15:00, Xetra 14:00, New York 08:00 (closed).
const MIDDAY = new Date("2026-07-01T12:00Z");
const SATURDAY = new Date("2026-07-04T12:00Z");

const seedAccount = async (db: TestDb): Promise<number> => {
  const userId = crypto.randomUUID();
  await db
    .insert(user)
    .values({
      id: userId,
      name: "Testi",
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
  return account.id;
};

const seedInstrument = async (
  db: TestDb,
  over: Partial<typeof instruments.$inferInsert> = {},
): Promise<number> =>
  (
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
      .get()
  ).id;

const seedTxn = async (
  db: TestDb,
  args: { accountId: number; instrumentId: number; type: "BUY" | "SELL"; quantity: number },
): Promise<void> => {
  await db
    .insert(transactions)
    .values({
      accountId: args.accountId,
      instrumentId: args.instrumentId,
      type: args.type,
      tradeDate: "2026-01-02",
      quantity: args.quantity,
      amount: 0,
      currency: EUR,
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
    })
    .run();
};

const seedHeld = async (db: TestDb, symbol: string): Promise<number> => {
  const accountId = await seedAccount(db);
  const instrumentId = await seedInstrument(db, { ticker: symbol, sourceKey: symbol });
  await seedTxn(db, { accountId, instrumentId, type: "BUY", quantity: 10_000_000 });
  return instrumentId;
};

const chartStub = () => {
  const urls: string[] = [];
  const fetchImpl: FetchImpl = async (input) => {
    urls.push(urlOf(input));
    return Response.json({
      chart: {
        result: [
          {
            meta: { currency: "EUR" },
            timestamp: [1782907200], // 2026-07-01T12:00Z
            indicators: { quote: [{ close: [4.31] }] },
          },
        ],
      },
    });
  };
  return { urls, fetchImpl };
};

const mustNotBeCalled: FetchImpl = async () => {
  throw new Error("must not be called");
};

test("heldInstrumentIds counts a position in any account, not one sold to zero", async () => {
  const { db } = await testDb();
  const held = await seedHeld(db, "NOKIA.HE");
  const accountId = await seedAccount(db);
  const sold = await seedInstrument(db, { sourceKey: "KCR.HE" });
  await seedTxn(db, { accountId, instrumentId: sold, type: "BUY", quantity: 5_000_000 });
  await seedTxn(db, { accountId, instrumentId: sold, type: "SELL", quantity: 5_000_000 });
  await seedInstrument(db, { sourceKey: "NEVER.HE" });

  expect([...(await heldInstrumentIds(db))]).toEqual([held]);
});

test("asks once for every open, held listing", async () => {
  const { db } = await testDb();
  const nokia = await seedHeld(db, "NOKIA.HE");
  const sap = await seedHeld(db, "SAP.DE");
  await seedHeld(db, "AAPL"); // New York is closed at MIDDAY
  const { urls, fetchImpl } = chartStub();

  const result = await refreshIntraday(db, MIDDAY, fetchImpl, 0);

  expect(result).toEqual({ asked: 2, written: 2, paused: false });
  expect(urls).toHaveLength(2);
  expect(urls.some((url) => url.includes("chart/NOKIA.HE"))).toBe(true);
  expect(urls.some((url) => url.includes("chart/SAP.DE"))).toBe(true);
  const stored = await db.select().from(prices).all();
  const byId = (a: number, b: number): number => a - b;
  expect(stored.map((row) => row.instrumentId).toSorted(byId)).toEqual([nokia, sap].toSorted(byId));
  expect(stored.every((row) => row.date === "2026-07-01" && row.close === 431)).toBe(true);
});

test("no open exchange, no request", async () => {
  const { db } = await testDb();
  await seedHeld(db, "NOKIA.HE");
  const result = await refreshIntraday(db, SATURDAY, mustNotBeCalled, 0);
  expect(result).toEqual({ asked: 0, written: 0, paused: false });
});

test("an instrument nobody holds is not asked for", async () => {
  const { db } = await testDb();
  await seedInstrument(db, { sourceKey: "NOKIA.HE" });
  const result = await refreshIntraday(db, MIDDAY, mustNotBeCalled, 0);
  expect(result).toEqual({ asked: 0, written: 0, paused: false });
});

test("a held fund is left to the evening run", async () => {
  const { db } = await testDb();
  const accountId = await seedAccount(db);
  const fund = await seedInstrument(db, {
    kind: "fund",
    priceSource: "op_fund",
    sourceKey: "op-maailma-indeksi",
    ticker: null,
  });
  await seedTxn(db, { accountId, instrumentId: fund, type: "BUY", quantity: 1_000_000 });
  const result = await refreshIntraday(db, MIDDAY, mustNotBeCalled, 0);
  expect(result).toEqual({ asked: 0, written: 0, paused: false });
});

test("a paused gate makes no request and reports paused", async () => {
  const { db } = await testDb();
  await seedHeld(db, "NOKIA.HE");
  await db
    .insert(yahooGate)
    .values({ id: 1, pausedUntil: MIDDAY.getTime() + 60 * 60_000, backoffMs: 15 * 60_000 })
    .run();
  const result = await refreshIntraday(db, MIDDAY, mustNotBeCalled, 0);
  expect(result).toEqual({ asked: 0, written: 0, paused: true });
});

test("a 429 mid-run keeps the prices already fetched and reports paused", async () => {
  const { db } = await testDb();
  const nokia = await seedHeld(db, "NOKIA.HE");
  await seedHeld(db, "SAP.DE");
  const { fetchImpl: ok } = chartStub();
  const calls = { count: 0 };
  const fetchImpl: FetchImpl = async (input, init) => {
    calls.count += 1;
    return calls.count === 1 ? ok(input, init) : new Response("", { status: 429 });
  };

  const result = await refreshIntraday(db, MIDDAY, fetchImpl, 0);

  expect(result).toEqual({ asked: 2, written: 1, paused: true });
  expect(calls.count).toBe(2);
  const stored = await db.select().from(prices).all();
  expect(stored.map((row) => row.instrumentId)).toEqual([nokia]);
});
