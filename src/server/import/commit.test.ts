import { test, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { testDb } from "../db";
import { accounts, fxRates, imports, instruments, transactions, user } from "../db/schema";
import { EUR, parseCurrency } from "../../core/money";
import { commitDraft, undoImport } from "./commit";
import type { Draft, DraftTxn } from "./map";
import type { FetchImpl } from "../prices/types";
import { ECB_DATA_URL } from "../fx-ecb";

const USD = parseCurrency("USD");
const SEK = parseCurrency("SEK");

const seed = () => {
  const { db } = testDb();
  db.insert(user)
    .values({
      id: "u1",
      name: "Testi",
      email: "t@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  const account = db
    .insert(accounts)
    .values({ userId: "u1", name: "Nordnet", broker: "nordnet", baseCurrency: EUR })
    .returning()
    .get();
  const nokia = db
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
  accountRef: null,
  ...over,
});

const draftOf = (txns: DraftTxn[]): Draft => ({
  txns,
  problems: [],
  unknownIsins: [],
  accountRefs: [],
});

const args = (accountId: number, draft: Draft, fetchImpl?: FetchImpl) => ({
  userId: "u1",
  accountId,
  kind: "csv_nordnet" as const,
  filename: "x.csv",
  sha256: "deadbeef",
  draft,
  fetchImpl,
});

/**
 * A `fetchImpl` simulating "ECB has nothing for this currency today" (a 503, as a real
 * outage would look) -- for a test that means to pin down the still-unresolved-after-trying
 * refusal (C1b's `ensureFxRate` swallows a fetch failure to `null`, exactly like ECB
 * genuinely lacking the currency would), without depending on the global test-network
 * guard's own error text to keep that refusal message legible.
 */
const noEcbRate: FetchImpl = async () => new Response("", { status: 503 });

test("inserts draft rows and records the import", async () => {
  const { db, accountId } = seed();
  const result = await commitDraft(db, args(accountId, draftOf([draftTxn({ accountId })])));
  expect(result.inserted).toBe(1);
  expect(result.skipped).toBe(0);
  const rows = db.select().from(transactions).all();
  expect(rows[0]!.importId).toBe(result.importId);
  // The counts commitDraft() returns must also be the ones written onto the
  // `imports` row itself -- /api/imports (the history listing) reads these
  // back later, potentially long after the in-memory CommitResult above is
  // gone, and (once undone) after `transactions` no longer has any row to
  // recount them from at all -- see schema.ts's own comment on these columns.
  const importRow = db.select().from(imports).where(eq(imports.id, result.importId)).get()!;
  expect(importRow.insertedCount).toBe(1);
  expect(importRow.skippedCount).toBe(0);
});

test("skips a row already present by external id", async () => {
  const { db, accountId } = seed();
  const row = draftTxn({ accountId, externalId: "1001" });
  await commitDraft(db, args(accountId, draftOf([row])));
  const second = await commitDraft(db, args(accountId, draftOf([row])));
  expect(second.inserted).toBe(0);
  expect(second.skipped).toBe(1);
  expect(db.select().from(transactions).all()).toHaveLength(1);
  // The second import's own row records that it skipped everything -- a
  // skipped row was never inserted, so there is no `transactions` row to
  // ever recount this from later; it must be captured at commit time.
  const secondImportRow = db.select().from(imports).where(eq(imports.id, second.importId)).get()!;
  expect(secondImportRow.insertedCount).toBe(0);
  expect(secondImportRow.skippedCount).toBe(1);
});

test("skips a row already present by content hash when there is no external id", async () => {
  const { db, accountId } = seed();
  const row = draftTxn({ accountId });
  await commitDraft(db, args(accountId, draftOf([row])));
  const second = await commitDraft(db, args(accountId, draftOf([row])));
  expect(second.inserted).toBe(0);
  expect(second.skipped).toBe(1);
  expect(db.select().from(transactions).all()).toHaveLength(1);
});

// Both rows below have identical material (same type, date, isin,
// quantity, amount, fee, currency) -- contentHash() (Task 11) deliberately
// ignores externalId, so a naive `content_hash` column would collide the
// two on the schema's (accountId, content_hash) unique index even though
// they carry distinct external ids and are genuinely different
// transactions (e.g. two same-day, same-amount deposits from a real
// broker export). Both must insert.
test("two distinct rows with different external ids but identical material both insert", async () => {
  const { db, accountId } = seed();
  const draft = draftOf([
    draftTxn({ accountId, externalId: "a" }),
    draftTxn({ accountId, externalId: "b" }),
  ]);
  const result = await commitDraft(db, args(accountId, draft));
  expect(result.inserted).toBe(2);
  expect(result.skipped).toBe(0);
  expect(db.select().from(transactions).all()).toHaveLength(2);
});

test("refuses a draft with unresolved isins", async () => {
  const { db, accountId } = seed();
  const draft: Draft = {
    txns: [draftTxn({ accountId })],
    problems: [],
    unknownIsins: [{ isin: "IE00B4L5Y983", name: "IWDA", currency: EUR }],
    accountRefs: [],
  };
  await expect(commitDraft(db, args(accountId, draft))).rejects.toThrow(/IE00B4L5Y983/);
});

// Review finding: a broker with no ISIN column at all (OP's web-paste view,
// see brokers.ts) reports its unknown instruments with `isin: null`. The
// refusal message must fall back to `name` there -- `Array.prototype.join`
// renders a null array entry as an empty string, so without the fallback
// this would throw a message naming nothing at all.
test("refuses a draft with an unresolved instrument that has no isin, naming it by name instead", async () => {
  const { db, accountId } = seed();
  const draft: Draft = {
    txns: [draftTxn({ accountId })],
    problems: [],
    unknownIsins: [{ isin: null, name: "OP-Maailma Indeksi A", currency: EUR }],
    accountRefs: [],
  };
  await expect(commitDraft(db, args(accountId, draft))).rejects.toThrow(/OP-Maailma Indeksi A/);
});

// DraftTxn.type (Task 11) is a plain string -- nothing upstream guarantees
// it matches the ledger's stricter enum. commitDraft validates it against
// the schema's own enum before trusting it, rather than asserting past
// TypeScript with a cast; this pins that validation down.
test("refuses a row whose type is not a real ledger transaction type", async () => {
  const { db, accountId } = seed();
  const bogus = draftTxn({ accountId, type: "NOT_A_REAL_TYPE" });
  await expect(commitDraft(db, args(accountId, draftOf([bogus])))).rejects.toThrow(
    /tuntematon tapahtumatyyppi/i,
  );
});

// C1b: a missing fx rate no longer refuses outright -- commitDraft first tries one
// on-demand ECB fetch per unresolved currency (see fx.ts's ensureFxRate). `noEcbRate`
// simulates ECB genuinely having nothing for this row (an outage, or -- since ECB's daily
// file carries no history -- a currency/date it just can't serve), so the refusal this test
// pins down is still reached, just one step later than before.
test("refuses a usd row with no fx rate on or before its trade date, even after trying ECB on demand", async () => {
  const { db, accountId, instrumentId } = seed();
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
    /valuuttakurssi/i,
  );
});

test("resolves a usd row at the newest rate on or before its trade date", async () => {
  const { db, accountId, instrumentId } = seed();
  db.insert(fxRates)
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
  // A matching rate is already seeded, so ensureDraftFxRates finds it without ever
  // calling fetchImpl -- no stub needed here, matching the pre-C1b test exactly.
  await commitDraft(db, args(accountId, draftOf([usd])));
  expect(db.select().from(transactions).all()[0]!.fxRateEur).toBe(92_000_000);
});

// The real portfolio holds SEK, never USD (§10a A1) -- these two mirror the
// USD tests above with SEK to prove the no-fx-rate refusal and the
// newest-rate-on-or-before resolution generalize to any non-EUR currency,
// not just the one hardcoded example that used to be the only other option.
test("refuses a sek row with no fx rate on or before its trade date, even after trying ECB on demand", async () => {
  const { db, accountId, instrumentId } = seed();
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
    /valuuttakurssi/i,
  );
});

test("resolves a sek row at the newest rate on or before its trade date", async () => {
  const { db, accountId, instrumentId } = seed();
  db.insert(fxRates)
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
  expect(db.select().from(transactions).all()[0]!.fxRateEur).toBe(9_200_000);
});

// --- C1b: on-demand ECB fetch breaks the "first non-EUR transaction" deadlock ---

test("a first-ever non-EUR transaction commits by fetching ECB's rate on demand instead of deadlocking", async () => {
  const { db, accountId, instrumentId } = seed();
  // No fx_rates row exists at all for SEK -- exactly the deadlock C1b describes:
  // refreshFxRates() would never have fetched SEK either, since the ledger doesn't hold
  // it yet. `fetchImpl` here plays ECB's SDMX csvdata response (see fx-ecb.ts), dated on
  // the trade date so `fxRateOn`'s `lte` finds it.
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
  const stored = db.select().from(transactions).all()[0]!;
  expect(stored.currency).toBe(SEK);
  expect(stored.fxRateEur).toBeGreaterThan(0);
  // The fetched rate is also persisted, so a later row (or refreshFxRates) never
  // needs to hit the network again for this date/currency.
  expect(db.select().from(fxRates).where(eq(fxRates.currency, SEK)).all()).toHaveLength(1);
});

// --- Historical-fx fix: a *back-dated* first-ever transaction is no longer blocked either ---
// (previously C1b's fetchImpl could only ever supply today's ECB rate -- see fx.ts's
// `ensureFxRate` and `ECB_HIST_URL` comments for the confirmed real gap this closes)

test("a back-dated transaction in a currency never held before now commits, by falling back to ECB's historical file instead of just today's", async () => {
  const { db, accountId, instrumentId } = seed();
  // The daily file only ever carries today's rate (2026-08-27 here), well after this
  // back-dated trade -- on its own this would still deadlock exactly like the old,
  // un-fixed C1b case. `fetchImpl` plays both real ECB endpoints: the daily one (dated
  // "today"), and the historical one (verified real shape -- see fx.ts's `ECB_HIST_URL`
  // comment), which is what actually covers 2020-01-02.
  const fetchImpl: FetchImpl = async (input) => {
    const url = String(input);
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
  const stored = db.select().from(transactions).all()[0]!;
  expect(stored.currency).toBe(SEK);
  expect(stored.fxRateEur).toBeGreaterThan(0);
  // Resolved from the historical row dated exactly the trade date, not carried over
  // from the daily file's unrelated 2026-08-27 rate.
  expect(db.select().from(fxRates).where(eq(fxRates.date, "2020-01-02")).all()).toHaveLength(1);
});

test("a failure part-way through leaves the ledger untouched", async () => {
  const { db, accountId } = seed();
  const good = draftTxn({ accountId, externalId: "a" });
  const bad = draftTxn({ accountId, externalId: "b", currency: USD, fxRateEur: 0 });
  await expect(commitDraft(db, args(accountId, draftOf([good, bad]), noEcbRate))).rejects.toThrow();
  expect(db.select().from(transactions).all()).toHaveLength(0);
});

test("undo removes exactly the rows of that import", async () => {
  const { db, accountId } = seed();
  const first = await commitDraft(
    db,
    args(accountId, draftOf([draftTxn({ accountId, externalId: "a" })])),
  );
  await commitDraft(db, args(accountId, draftOf([draftTxn({ accountId, externalId: "b" })])));
  expect(undoImport(db, { userId: "u1", importId: first.importId }).deleted).toBe(1);
  expect(db.select().from(transactions).all()).toHaveLength(1);
});

test("undo refuses when a later sale depends on units the import introduced", async () => {
  const { db, accountId, instrumentId } = seed();
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
  expect(() => undoImport(db, { userId: "u1", importId: buy.importId })).toThrow(/myöhempi/i);
});

test("undo refuses an import belonging to another user", async () => {
  const { db, accountId } = seed();
  const created = await commitDraft(db, args(accountId, draftOf([draftTxn({ accountId })])));
  expect(() => undoImport(db, { userId: "someone-else", importId: created.importId })).toThrow();
});

// --- Extra coverage: the `IS NOT` guard predicate must also treat a later
// transaction that carries no importId at all (e.g. a manually entered row,
// never routed through commitDraft) as "belongs to a different import" and
// block the undo -- SQLite's `IS NOT` is a NULL-safe inequality, so
// `NULL IS NOT 5` is true, but this is worth pinning down with a real test
// rather than trusting the read of the SQL semantics alone.
test("undo refuses when a later transaction with no import id at all depends on the units", async () => {
  const { db, accountId, instrumentId } = seed();
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
  // Bypasses commitDraft entirely -- importId is left NULL, as a manually
  // entered ledger row (Task 16) would be.
  db.insert(transactions)
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
  expect(() => undoImport(db, { userId: "u1", importId: buy.importId })).toThrow(/myöhempi/i);
});

test("undo refuses an already-undone import", async () => {
  const { db, accountId } = seed();
  const created = await commitDraft(db, args(accountId, draftOf([draftTxn({ accountId })])));
  undoImport(db, { userId: "u1", importId: created.importId });
  expect(() => undoImport(db, { userId: "u1", importId: created.importId })).toThrow();
});

test("undo of an unknown import id throws", () => {
  const { db } = seed();
  expect(() => undoImport(db, { userId: "u1", importId: 999_999 })).toThrow();
});

// A Nordnet export routinely covers several accounts -- an arvo-osuustili and
// an osakesäästötili sit in one file and are taxed differently. Filing them all
// under the account picked on the import screen merges two portfolios, and every
// per-account figure downstream is then wrong: a reconciliation compares against
// one account, and the broker reports its return per account.
test("rows carrying different broker account numbers are filed into separate accounts", async () => {
  const { db, accountId } = seed();
  const draft: Draft = {
    txns: [
      draftTxn({ accountId, type: "DEPOSIT", amount: 10_000, accountRef: "11223344" }),
      draftTxn({ accountId, type: "DEPOSIT", amount: 20_000, accountRef: "55667788" }),
    ],
    problems: [],
    unknownIsins: [],
    accountRefs: [
      { ref: "11223344", rows: 1 },
      { ref: "55667788", rows: 1 },
    ],
  };

  const result = await commitDraft(db, args(accountId, draft));
  expect(result.inserted).toBe(2);

  const rows = db.select().from(transactions).all();
  const accountIds = new Set(rows.map((r) => r.accountId));
  expect(accountIds.size).toBe(2);

  // The new account is named after the number, so the mapping is visible and
  // correctable rather than hidden.
  const created = db.select().from(accounts).all();
  expect(created.some((a) => a.name.includes("55667788"))).toBe(true);
});

test("a row with no broker account number goes to the account the user picked", async () => {
  const { db, accountId } = seed();
  const draft: Draft = {
    txns: [draftTxn({ accountId, type: "DEPOSIT", amount: 10_000 })],
    problems: [],
    unknownIsins: [],
    accountRefs: [],
  };

  await commitDraft(db, args(accountId, draft));
  expect(db.select().from(transactions).all()[0]!.accountId).toBe(accountId);
  // No stray account was invented for an export that names none.
  expect(db.select().from(accounts).all()).toHaveLength(1);
});

test("re-importing the same multi-account file reuses the accounts it created", async () => {
  const { db, accountId } = seed();
  const draft: Draft = {
    txns: [draftTxn({ accountId, type: "DEPOSIT", amount: 10_000, accountRef: "55667788" })],
    problems: [],
    unknownIsins: [],
    accountRefs: [{ ref: "55667788", rows: 1 }],
  };

  await commitDraft(db, args(accountId, draft));
  await commitDraft(db, args(accountId, draft));
  // Matched by the number appearing in the name, so the second import does not
  // create a duplicate account beside the first.
  expect(db.select().from(accounts).all()).toHaveLength(2);
});
