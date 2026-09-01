import { expect, test } from "vitest";
import { eq } from "drizzle-orm";

import { EUR } from "../../core/money.ts";
import { testDb } from "../db/test-db.ts";
import { accounts, instruments, priceFetchLog, prices, transactions, user } from "../db/schema.ts";
import type { FetchImpl } from "../prices/types.ts";
import { backfillCommittedInstruments } from "./backfill-on-commit.ts";
import { commitDraft } from "./commit.ts";
import type { Draft, DraftTxn } from "./map.ts";

/**
 * Mirrors commit.test.ts's own `seed`/`draftTxn`/`draftOf` helpers -- this file exercises the
 * same `commitDraft` these tests do, immediately followed by `backfillCommittedInstruments`,
 * exactly as `src/server/import/service.ts`'s two commit paths wire the two together. A fresh,
 * isolated `testDb()` per test (not the process-wide shared handle `imports.test.ts` uses) is
 * deliberate here too: `backfillCommittedInstruments` takes `db` as an explicit parameter
 * (like `commitDraft`), so it needs no HTTP layer, real auth, or a random ISIN to stay isolated
 * from every other test file sharing that process-wide database.
 */
const seed = async () => {
  const { db } = await testDb();
  await db
    .insert(user)
    .values({
      id: "u1",
      name: "Testi",
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
  const instrument = await db
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
  return { db, accountId: account.id, instrumentId: instrument.id };
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

const draftOf = (txns: DraftTxn[]): Draft => ({ txns, problems: [], unknownIsins: [] });

const commitArgs = (accountId: number, draft: Draft) => ({
  userId: "u1",
  accountId,
  kind: "csv_nordnet" as const,
  filename: "x.csv",
  sha256: "deadbeef",
  draft,
});

const mustNotBeCalled = async (): Promise<Response> => {
  throw new Error("must not be called");
};

const onePointAt2020_06_15: FetchImpl = async () =>
  Response.json({
    chart: {
      result: [
        {
          meta: { currency: "EUR" },
          timestamp: [1592179200], // 2020-06-15T00:00:00Z
          indicators: { quote: [{ close: [3.0] }] },
        },
      ],
    },
  });

test("does nothing, and touches no network, when the committed draft has no instrument rows", async () => {
  const { db, accountId } = await seed();
  const draft = draftOf([draftTxn({ accountId })]); // a plain deposit, instrumentId stays null
  await commitDraft(db, commitArgs(accountId, draft));

  await expect(
    backfillCommittedInstruments(db, draft, { fetchImpl: mustNotBeCalled }),
  ).resolves.toBeUndefined();
  expect(await db.select().from(prices).all()).toHaveLength(0);
});

test("backfills the instrument a fresh commit just gave an earliest transaction date", async () => {
  const { db, accountId, instrumentId } = await seed();
  const draft = draftOf([
    draftTxn({
      accountId,
      instrumentId,
      type: "BUY",
      tradeDate: "2020-06-15",
      quantity: 10_000_000,
      unitPrice: 300,
      amount: -3_000_00,
    }),
  ]);
  await commitDraft(db, commitArgs(accountId, draft));

  await backfillCommittedInstruments(db, draft, { fetchImpl: onePointAt2020_06_15 });

  const rows = await db.select().from(prices).where(eq(prices.instrumentId, instrumentId)).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ date: "2020-06-15", close: 300 });
});

test("re-importing the same rows (all skipped as duplicates) still triggers backfill -- how a pre-existing holding catches up without waiting for the nightly sweep", async () => {
  const { db, accountId, instrumentId } = await seed();
  const draft = draftOf([
    draftTxn({
      accountId,
      instrumentId,
      type: "BUY",
      tradeDate: "2020-06-15",
      quantity: 10_000_000,
      unitPrice: 300,
      amount: -3_000_00,
      externalId: "n1",
    }),
  ]);
  await commitDraft(db, commitArgs(accountId, draft));

  const second = await commitDraft(db, commitArgs(accountId, draft));
  expect(second.inserted).toBe(0);
  expect(second.skipped).toBe(1);

  let called = false;
  const fetchImpl: FetchImpl = async (...args) => {
    called = true;
    return onePointAt2020_06_15(...args);
  };
  await backfillCommittedInstruments(db, draft, { fetchImpl });
  expect(called).toBe(true);
});

test("never rejects when the price source fails -- the commit it followed must not be reported as failed", async () => {
  const { db, accountId, instrumentId } = await seed();
  const draft = draftOf([
    draftTxn({
      accountId,
      instrumentId,
      type: "BUY",
      tradeDate: "2020-06-15",
      quantity: 10_000_000,
      unitPrice: 300,
      amount: -3_000_00,
    }),
  ]);
  const commitResult = await commitDraft(db, commitArgs(accountId, draft));
  expect(commitResult.inserted).toBe(1); // the commit itself succeeded...

  const throwing: FetchImpl = async () => {
    throw new Error("Yahoo on poissa käytöstä");
  };
  // ...and this, called right after exactly as imports.ts calls it, resolves rather than
  // rejecting even though the price source it drives is completely down.
  await expect(
    backfillCommittedInstruments(db, draft, { fetchImpl: throwing }),
  ).resolves.toBeUndefined();

  const log = await db
    .select()
    .from(priceFetchLog)
    .where(eq(priceFetchLog.instrumentId, instrumentId))
    .all();
  expect(log).toHaveLength(1);
  expect(log[0]!.ok).toBe(false);
  expect(log[0]!.message).toContain("Yahoo on poissa käytöstä");
  // The committed transaction itself is untouched by the failed backfill.
  expect(await db.select().from(transactions).all()).toHaveLength(1);
});

test("deduplicates repeated instrument ids across a draft's rows into a single fetch", async () => {
  const { db, accountId, instrumentId } = await seed();
  const draft = draftOf([
    draftTxn({
      accountId,
      instrumentId,
      type: "BUY",
      tradeDate: "2020-06-15",
      quantity: 10_000_000,
      unitPrice: 300,
      amount: -3_000_00,
      externalId: "n1",
    }),
    draftTxn({
      accountId,
      instrumentId,
      type: "BUY",
      tradeDate: "2021-01-04",
      quantity: 5_000_000,
      unitPrice: 320,
      amount: -1_600_00,
      externalId: "n2",
    }),
  ]);
  await commitDraft(db, commitArgs(accountId, draft));

  let calls = 0;
  const fetchImpl: FetchImpl = async (...args) => {
    calls++;
    return onePointAt2020_06_15(...args);
  };
  await backfillCommittedInstruments(db, draft, { fetchImpl });
  expect(calls).toBe(1);
});
