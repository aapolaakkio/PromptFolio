import { test, expect } from "bun:test";
import { testDb } from "../db";
import { accounts, fxRates, instruments, transactions, user } from "../db/schema";
import { commitDraft, undoImport } from "./commit";
import type { Draft, DraftTxn } from "./map";

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
    .values({ userId: "u1", name: "Nordnet", broker: "nordnet", baseCurrency: "EUR" })
    .returning()
    .get();
  const nokia = db
    .insert(instruments)
    .values({
      isin: "FI0009000681",
      ticker: "NOKIA.HE",
      name: "Nokia",
      kind: "stock",
      currency: "EUR",
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
  currency: "EUR",
  fxRateEur: 100_000_000,
  externalId: null,
  ...over,
});

const draftOf = (txns: DraftTxn[]): Draft => ({ txns, problems: [], unknownIsins: [] });

const args = (accountId: number, draft: Draft) => ({
  userId: "u1",
  accountId,
  kind: "csv_nordnet" as const,
  filename: "x.csv",
  sha256: "deadbeef",
  draft,
});

test("inserts draft rows and records the import", () => {
  const { db, accountId } = seed();
  const result = commitDraft(db, args(accountId, draftOf([draftTxn({ accountId })])));
  expect(result.inserted).toBe(1);
  expect(result.skipped).toBe(0);
  const rows = db.select().from(transactions).all();
  expect(rows[0]!.importId).toBe(result.importId);
});

test("skips a row already present by external id", () => {
  const { db, accountId } = seed();
  const row = draftTxn({ accountId, externalId: "1001" });
  commitDraft(db, args(accountId, draftOf([row])));
  const second = commitDraft(db, args(accountId, draftOf([row])));
  expect(second.inserted).toBe(0);
  expect(second.skipped).toBe(1);
  expect(db.select().from(transactions).all()).toHaveLength(1);
});

test("skips a row already present by content hash when there is no external id", () => {
  const { db, accountId } = seed();
  const row = draftTxn({ accountId });
  commitDraft(db, args(accountId, draftOf([row])));
  const second = commitDraft(db, args(accountId, draftOf([row])));
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
test("two distinct rows with different external ids but identical material both insert", () => {
  const { db, accountId } = seed();
  const draft = draftOf([
    draftTxn({ accountId, externalId: "a" }),
    draftTxn({ accountId, externalId: "b" }),
  ]);
  const result = commitDraft(db, args(accountId, draft));
  expect(result.inserted).toBe(2);
  expect(result.skipped).toBe(0);
  expect(db.select().from(transactions).all()).toHaveLength(2);
});

test("refuses a draft with unresolved isins", () => {
  const { db, accountId } = seed();
  const draft: Draft = {
    txns: [draftTxn({ accountId })],
    problems: [],
    unknownIsins: [{ isin: "IE00B4L5Y983", name: "IWDA" }],
  };
  expect(() => commitDraft(db, args(accountId, draft))).toThrow(/IE00B4L5Y983/);
});

// Review finding: a broker with no ISIN column at all (OP's web-paste view,
// see brokers.ts) reports its unknown instruments with `isin: null`. The
// refusal message must fall back to `name` there -- `Array.prototype.join`
// renders a null array entry as an empty string, so without the fallback
// this would throw a message naming nothing at all.
test("refuses a draft with an unresolved instrument that has no isin, naming it by name instead", () => {
  const { db, accountId } = seed();
  const draft: Draft = {
    txns: [draftTxn({ accountId })],
    problems: [],
    unknownIsins: [{ isin: null, name: "OP-Maailma Indeksi A" }],
  };
  expect(() => commitDraft(db, args(accountId, draft))).toThrow(/OP-Maailma Indeksi A/);
});

// DraftTxn.type (Task 11) is a plain string -- nothing upstream guarantees
// it matches the ledger's stricter enum. commitDraft validates it against
// the schema's own enum before trusting it, rather than asserting past
// TypeScript with a cast; this pins that validation down.
test("refuses a row whose type is not a real ledger transaction type", () => {
  const { db, accountId } = seed();
  const bogus = draftTxn({ accountId, type: "NOT_A_REAL_TYPE" });
  expect(() => commitDraft(db, args(accountId, draftOf([bogus])))).toThrow(
    /tuntematon tapahtumatyyppi/i,
  );
});

test("refuses a usd row with no fx rate on or before its trade date", () => {
  const { db, accountId, instrumentId } = seed();
  const usd = draftTxn({
    accountId,
    instrumentId,
    isin: "FI0009000681",
    type: "BUY",
    tradeDate: "2025-05-02",
    quantity: 10_000_000,
    amount: -98570,
    currency: "USD",
    fxRateEur: 0,
  });
  expect(() => commitDraft(db, args(accountId, draftOf([usd])))).toThrow(/valuuttakurssi/i);
});

test("resolves a usd row at the newest rate on or before its trade date", () => {
  const { db, accountId, instrumentId } = seed();
  db.insert(fxRates)
    .values([
      { date: "2025-04-30", currency: "USD", rateEur: 93_000_000 },
      { date: "2025-05-02", currency: "USD", rateEur: 92_000_000 },
      { date: "2025-05-05", currency: "USD", rateEur: 91_000_000 },
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
    currency: "USD",
    fxRateEur: 0,
  });
  commitDraft(db, args(accountId, draftOf([usd])));
  expect(db.select().from(transactions).all()[0]!.fxRateEur).toBe(92_000_000);
});

test("a failure part-way through leaves the ledger untouched", () => {
  const { db, accountId } = seed();
  const good = draftTxn({ accountId, externalId: "a" });
  const bad = draftTxn({ accountId, externalId: "b", currency: "USD", fxRateEur: 0 });
  expect(() => commitDraft(db, args(accountId, draftOf([good, bad])))).toThrow();
  expect(db.select().from(transactions).all()).toHaveLength(0);
});

test("undo removes exactly the rows of that import", () => {
  const { db, accountId } = seed();
  const first = commitDraft(
    db,
    args(accountId, draftOf([draftTxn({ accountId, externalId: "a" })])),
  );
  commitDraft(db, args(accountId, draftOf([draftTxn({ accountId, externalId: "b" })])));
  expect(undoImport(db, { userId: "u1", importId: first.importId }).deleted).toBe(1);
  expect(db.select().from(transactions).all()).toHaveLength(1);
});

test("undo refuses when a later sale depends on units the import introduced", () => {
  const { db, accountId, instrumentId } = seed();
  const buy = commitDraft(
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
  commitDraft(
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

test("undo refuses an import belonging to another user", () => {
  const { db, accountId } = seed();
  const created = commitDraft(db, args(accountId, draftOf([draftTxn({ accountId })])));
  expect(() => undoImport(db, { userId: "someone-else", importId: created.importId })).toThrow();
});

// --- Extra coverage: the `IS NOT` guard predicate must also treat a later
// transaction that carries no importId at all (e.g. a manually entered row,
// never routed through commitDraft) as "belongs to a different import" and
// block the undo -- SQLite's `IS NOT` is a NULL-safe inequality, so
// `NULL IS NOT 5` is true, but this is worth pinning down with a real test
// rather than trusting the read of the SQL semantics alone.
test("undo refuses when a later transaction with no import id at all depends on the units", () => {
  const { db, accountId, instrumentId } = seed();
  const buy = commitDraft(
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
      currency: "EUR",
      fxRateEur: 100_000_000,
      externalId: "manual-sell",
      contentHash: "manual-sell-hash",
      importId: null,
    })
    .run();
  expect(() => undoImport(db, { userId: "u1", importId: buy.importId })).toThrow(/myöhempi/i);
});

test("undo refuses an already-undone import", () => {
  const { db, accountId } = seed();
  const created = commitDraft(db, args(accountId, draftOf([draftTxn({ accountId })])));
  undoImport(db, { userId: "u1", importId: created.importId });
  expect(() => undoImport(db, { userId: "u1", importId: created.importId })).toThrow();
});

test("undo of an unknown import id throws", () => {
  const { db } = seed();
  expect(() => undoImport(db, { userId: "u1", importId: 999_999 })).toThrow();
});
