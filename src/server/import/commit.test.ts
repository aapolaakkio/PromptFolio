import { test, expect } from "vitest";
import { urlOf } from "../prices/types.ts";
import { eq } from "drizzle-orm";
import { testDb } from "../db/test-db.ts";
import { accounts, fxRates, imports, instruments, transactions, user } from "../db/schema.ts";
import { EUR, parseCurrency } from "../../core/money.ts";
import { commitDraft, undoImport } from "./commit.ts";
import type { Draft, DraftTxn } from "./map.ts";
import type { FetchImpl } from "../prices/types.ts";
import { ECB_DATA_URL } from "../fx-ecb.ts";

const USD = parseCurrency("USD");
const SEK = parseCurrency("SEK");

const seed = async () => {
  const { db } = await testDb();
  await db
    .insert(user)
    .values({
      id: "u1",
      name: "Test",
      email: "t@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  const account = await db
    .insert(accounts)
    .values({ userId: "u1", name: "Nordnet", broker: "nordnet", baseCurrency: EUR })
    .returning()
    .get();
  const nokia = await db
    .insert(instruments)
    .values({
      isin: "FI0009000681",
      ticker: "NOKIA.HE",
      name: "Nokia",
      kind: "stock",
      currency: EUR,
      priceSource: "yahoo",
      sourceKey: "NOKIA.HE",
    })
    .returning()
    .get();
  return { db, accountId: account.id, instrumentId: nokia.id };
};

const draftTxn = (over: Partial<DraftTxn> & { accountId: number }): DraftTxn => ({
  line: 2,
  instrumentId: null,
  isin: null,
  type: "DEPOSIT",
  tradeDate: "2025-01-01",
  quantity: 0,
  unitPrice: null,
  amount: 500_00,
  fee: 0,
  tax: 0,
  currency: EUR,
  fxRateEur: 100_000_000,
  externalId: null,
  note: null,
  ...over,
});

const draftOf = (txns: DraftTxn[]): Draft => ({ txns, problems: [], unknownIsins: [], added: [] });

const args = (accountId: number, draft: Draft, fetchImpl?: FetchImpl) => ({
  userId: "u1",
  accountId,
  kind: "csv_nordnet" as const,
  filename: "x.csv",
  sha256: "deadbeef",
  draft,
  fetchImpl,
});

const noEcbRate: FetchImpl = async () => new Response("", { status: 503 });

test("inserts draft rows and records the import", async () => {
  const { db, accountId } = await seed();
  const result = await commitDraft(db, args(accountId, draftOf([draftTxn({ accountId })])));
  expect(result.inserted).toBe(1);
  expect(result.skipped).toBe(0);
  const rows = await db.select().from(transactions).all();
  expect(rows[0]!.importId).toBe(result.importId);
  const importRow = await db.select().from(imports).where(eq(imports.id, result.importId)).get();
  expect(importRow).toBeDefined();
  if (importRow === undefined) return;
  expect(importRow.insertedCount).toBe(1);
  expect(importRow.skippedCount).toBe(0);
});

test("skips a row stored before its ISIN was known, now carrying one", async () => {
  const { db, accountId } = await seed();
  const row = draftTxn({ accountId, externalId: null });
  await commitDraft(db, args(accountId, draftOf([{ ...row, isin: null }])));
  const second = await commitDraft(
    db,
    args(accountId, draftOf([{ ...row, isin: "FI0009000681" }])),
  );
  expect(second.inserted).toBe(0);
  expect(second.skipped).toBe(1);
});

test("skips a row already present by external id", async () => {
  const { db, accountId } = await seed();
  const row = draftTxn({ accountId, externalId: "1001" });
  await commitDraft(db, args(accountId, draftOf([row])));
  const second = await commitDraft(db, args(accountId, draftOf([row])));
  expect(second.inserted).toBe(0);
  expect(second.skipped).toBe(1);
  expect(await db.select().from(transactions).all()).toHaveLength(1);
  const secondImportRow = await db
    .select()
    .from(imports)
    .where(eq(imports.id, second.importId))
    .get();
  expect(secondImportRow).toBeDefined();
  if (secondImportRow === undefined) return;
  expect(secondImportRow.insertedCount).toBe(0);
  expect(secondImportRow.skippedCount).toBe(1);
});

test("skips a row already present by content hash when there is no external id", async () => {
  const { db, accountId } = await seed();
  const row = draftTxn({ accountId });
  await commitDraft(db, args(accountId, draftOf([row])));
  const second = await commitDraft(db, args(accountId, draftOf([row])));
  expect(second.inserted).toBe(0);
  expect(second.skipped).toBe(1);
  expect(await db.select().from(transactions).all()).toHaveLength(1);
});

test("two distinct rows with different external ids but identical material both insert", async () => {
  const { db, accountId } = await seed();
  const draft = draftOf([
    draftTxn({ accountId, externalId: "a" }),
    draftTxn({ accountId, externalId: "b" }),
  ]);
  const result = await commitDraft(db, args(accountId, draft));
  expect(result.inserted).toBe(2);
  expect(result.skipped).toBe(0);
  expect(await db.select().from(transactions).all()).toHaveLength(2);
});

test("refuses a draft with unresolved isins", async () => {
  const { db, accountId } = await seed();
  const draft: Draft = {
    txns: [draftTxn({ accountId })],
    problems: [],
    unknownIsins: [{ isin: "IE00B4L5Y983", name: "IWDA", currency: EUR }],
    added: [],
  };
  await expect(commitDraft(db, args(accountId, draft))).rejects.toThrow(/IE00B4L5Y983/);
});

test("refuses a draft with an unresolved instrument that has no isin, naming it by name instead", async () => {
  const { db, accountId } = await seed();
  const draft: Draft = {
    txns: [draftTxn({ accountId })],
    problems: [],
    unknownIsins: [{ isin: null, name: "OP-Maailma Indeksi A", currency: EUR }],
    added: [],
  };
  await expect(commitDraft(db, args(accountId, draft))).rejects.toThrow(/OP-Maailma Indeksi A/);
});

test("refuses a row whose type is not a real ledger transaction type", async () => {
  const { db, accountId } = await seed();
  const bogus = draftTxn({ accountId, type: "NOT_A_REAL_TYPE" });
  await expect(commitDraft(db, args(accountId, draftOf([bogus])))).rejects.toThrow(
    /unknown transaction type/i,
  );
});

test("refuses a usd row with no fx rate on or before its trade date, even after trying ECB on demand", async () => {
  const { db, accountId, instrumentId } = await seed();
  const usd = draftTxn({
    accountId,
    instrumentId,
    isin: "FI0009000681",
    type: "BUY",
    tradeDate: "2025-05-02",
    quantity: 10_000_000,
    amount: -98570,
    currency: USD,
    fxRateEur: 0,
  });
  await expect(commitDraft(db, args(accountId, draftOf([usd]), noEcbRate))).rejects.toThrow(
    /exchange rate/i,
  );
});

test("resolves a usd row at the newest rate on or before its trade date", async () => {
  const { db, accountId, instrumentId } = await seed();
  await db
    .insert(fxRates)
    .values([
      { date: "2025-04-30", currency: USD, rateEur: 93_000_000 },
      { date: "2025-05-02", currency: USD, rateEur: 92_000_000 },
      { date: "2025-05-05", currency: USD, rateEur: 91_000_000 },
    ])
    .run();
  const usd = draftTxn({
    accountId,
    instrumentId,
    isin: "FI0009000681",
    type: "BUY",
    tradeDate: "2025-05-03",
    quantity: 10_000_000,
    amount: -98570,
    currency: USD,
    fxRateEur: 0,
  });
  await commitDraft(db, args(accountId, draftOf([usd])));
  expect((await db.select().from(transactions).all())[0]!.fxRateEur).toBe(92_000_000);
});

test("refuses a sek row with no fx rate on or before its trade date, even after trying ECB on demand", async () => {
  const { db, accountId, instrumentId } = await seed();
  const sek = draftTxn({
    accountId,
    instrumentId,
    isin: "FI0009000681",
    type: "BUY",
    tradeDate: "2025-05-02",
    quantity: 10_000_000,
    amount: -98570,
    currency: SEK,
    fxRateEur: 0,
  });
  await expect(commitDraft(db, args(accountId, draftOf([sek]), noEcbRate))).rejects.toThrow(
    /exchange rate/i,
  );
});

test("resolves a sek row at the newest rate on or before its trade date", async () => {
  const { db, accountId, instrumentId } = await seed();
  await db
    .insert(fxRates)
    .values([
      { date: "2025-04-30", currency: SEK, rateEur: 9_300_000 },
      { date: "2025-05-02", currency: SEK, rateEur: 9_200_000 },
      { date: "2025-05-05", currency: SEK, rateEur: 9_100_000 },
    ])
    .run();
  const sek = draftTxn({
    accountId,
    instrumentId,
    isin: "FI0009000681",
    type: "BUY",
    tradeDate: "2025-05-03",
    quantity: 10_000_000,
    amount: -98570,
    currency: SEK,
    fxRateEur: 0,
  });
  await commitDraft(db, args(accountId, draftOf([sek])));
  expect((await db.select().from(transactions).all())[0]!.fxRateEur).toBe(9_200_000);
});

test("a first-ever non-EUR transaction commits by fetching ECB's rate on demand instead of deadlocking", async () => {
  const { db, accountId, instrumentId } = await seed();
  const fetchImpl: FetchImpl = async () =>
    new Response(
      "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE\n" +
        "EXR.D.SEK.EUR.SP00.A,D,SEK,EUR,SP00,A,2025-05-02,10.9160\n",
    );
  const sek = draftTxn({
    accountId,
    instrumentId,
    isin: "FI0009000681",
    type: "BUY",
    tradeDate: "2025-05-02",
    quantity: 10_000_000,
    amount: -98570,
    currency: SEK,
    fxRateEur: 0,
  });
  const result = await commitDraft(db, args(accountId, draftOf([sek]), fetchImpl));
  expect(result.inserted).toBe(1);
  const stored = (await db.select().from(transactions).all())[0]!;
  expect(stored.currency).toBe(SEK);
  expect(stored.fxRateEur).toBeGreaterThan(0);
  expect(await db.select().from(fxRates).where(eq(fxRates.currency, SEK)).all()).toHaveLength(1);
});

test("a back-dated transaction in a currency never held before now commits, by falling back to ECB's historical file instead of just today's", async () => {
  const { db, accountId, instrumentId } = await seed();
  const fetchImpl: FetchImpl = async (input) => {
    const url = urlOf(input);
    if (!url.startsWith(ECB_DATA_URL)) throw new Error(`unexpected fetch: ${url}`);
    return new Response(
      "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE\nEXR.D.SEK.EUR.SP00.A,D,SEK,EUR,SP00,A,2020-01-02,10.9160\nEXR.D.SEK.EUR.SP00.A,D,SEK,EUR,SP00,A,2020-01-03,10.9200\nEXR.D.SEK.EUR.SP00.A,D,SEK,EUR,SP00,A,2026-08-27,11.2340\n",
    );
  };
  const sek = draftTxn({
    accountId,
    instrumentId,
    isin: "FI0009000681",
    type: "BUY",
    tradeDate: "2020-01-02",
    quantity: 10_000_000,
    amount: -98570,
    currency: SEK,
    fxRateEur: 0,
  });
  const result = await commitDraft(db, args(accountId, draftOf([sek]), fetchImpl));
  expect(result.inserted).toBe(1);
  const stored = (await db.select().from(transactions).all())[0]!;
  expect(stored.currency).toBe(SEK);
  expect(stored.fxRateEur).toBeGreaterThan(0);
  expect(await db.select().from(fxRates).where(eq(fxRates.date, "2020-01-02")).all()).toHaveLength(
    1,
  );
});

test("a failure part-way through leaves the ledger untouched", async () => {
  const { db, accountId } = await seed();
  const good = draftTxn({ accountId, externalId: "a" });
  const bad = draftTxn({ accountId, externalId: "b", currency: USD, fxRateEur: 0 });
  await expect(commitDraft(db, args(accountId, draftOf([good, bad]), noEcbRate))).rejects.toThrow();
  expect(await db.select().from(transactions).all()).toHaveLength(0);
});

test("undo removes exactly the rows of that import", async () => {
  const { db, accountId } = await seed();
  const first = await commitDraft(
    db,
    args(accountId, draftOf([draftTxn({ accountId, externalId: "a" })])),
  );
  await commitDraft(db, args(accountId, draftOf([draftTxn({ accountId, externalId: "b" })])));
  expect((await undoImport(db, { userId: "u1", importId: first.importId })).deleted).toBe(1);
  expect(await db.select().from(transactions).all()).toHaveLength(1);
});

test("undo refuses when a later sale depends on units the import introduced", async () => {
  const { db, accountId, instrumentId } = await seed();
  const buy = await commitDraft(
    db,
    args(
      accountId,
      draftOf([
        draftTxn({
          accountId,
          instrumentId,
          isin: "FI0009000681",
          type: "BUY",
          tradeDate: "2025-01-10",
          quantity: 100_000_000,
          amount: -41800,
          externalId: "buy",
        }),
      ]),
    ),
  );
  await commitDraft(
    db,
    args(
      accountId,
      draftOf([
        draftTxn({
          accountId,
          instrumentId,
          isin: "FI0009000681",
          type: "SELL",
          tradeDate: "2025-04-01",
          quantity: 40_000_000,
          amount: 18100,
          externalId: "sell",
        }),
      ]),
    ),
  );
  await expect(undoImport(db, { userId: "u1", importId: buy.importId })).rejects.toThrow(
    /later transaction/i,
  );
});

test("undo refuses an import belonging to another user", async () => {
  const { db, accountId } = await seed();
  const created = await commitDraft(db, args(accountId, draftOf([draftTxn({ accountId })])));
  await expect(
    undoImport(db, { userId: "someone-else", importId: created.importId }),
  ).rejects.toThrow();
});

test("undo refuses when a later transaction with no import id at all depends on the units", async () => {
  const { db, accountId, instrumentId } = await seed();
  const buy = await commitDraft(
    db,
    args(
      accountId,
      draftOf([
        draftTxn({
          accountId,
          instrumentId,
          isin: "FI0009000681",
          type: "BUY",
          tradeDate: "2025-01-10",
          quantity: 100_000_000,
          amount: -41800,
          externalId: "buy-manual-case",
        }),
      ]),
    ),
  );
  await db
    .insert(transactions)
    .values({
      accountId,
      instrumentId,
      type: "SELL",
      tradeDate: "2025-04-01",
      quantity: 40_000_000,
      amount: 18100,
      fee: 0,
      tax: 0,
      currency: EUR,
      fxRateEur: 100_000_000,
      externalId: "manual-sell",
      contentHash: "manual-sell-hash",
      importId: null,
    })
    .run();
  await expect(undoImport(db, { userId: "u1", importId: buy.importId })).rejects.toThrow(
    /later transaction/i,
  );
});

test("undo refuses an already-undone import", async () => {
  const { db, accountId } = await seed();
  const created = await commitDraft(db, args(accountId, draftOf([draftTxn({ accountId })])));
  await undoImport(db, { userId: "u1", importId: created.importId });
  await expect(undoImport(db, { userId: "u1", importId: created.importId })).rejects.toThrow();
});

test("undo of an unknown import id throws", async () => {
  const { db } = await seed();
  await expect(undoImport(db, { userId: "u1", importId: 999_999 })).rejects.toThrow();
});

test("a re-import fills in a row text the ledger is missing, without duplicating the row", async () => {
  const { db, accountId } = await seed();
  await commitDraft(db, args(accountId, draftOf([draftTxn({ accountId, note: null })])));

  const second = await commitDraft(
    db,
    args(accountId, draftOf([draftTxn({ accountId, note: "Internal to 12345678" })])),
  );

  expect(second.inserted).toBe(0);
  expect(second.enriched).toBe(1);
  expect(second.skipped).toBe(0);
  const rows = await db.select().from(transactions).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.note).toBe("Internal to 12345678");
});

test("a re-import never overwrites a row text the ledger already has", async () => {
  const { db, accountId } = await seed();
  await commitDraft(db, args(accountId, draftOf([draftTxn({ accountId, note: "First" })])));

  const second = await commitDraft(
    db,
    args(accountId, draftOf([draftTxn({ accountId, note: "Toinen" })])),
  );

  expect(second.enriched).toBe(0);
  expect(second.skipped).toBe(1);
  expect((await db.select().from(transactions).all())[0]!.note).toBe("First");
});
