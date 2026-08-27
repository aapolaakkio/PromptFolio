import { test, expect } from "bun:test";
import { EUR, formatMoney, parseCurrency } from "../core/money";
import { testDb } from "./db";
import { accounts, instruments, prices, transactions, user } from "./db/schema";
import { holdingsFor, loadPortfolio } from "./valuation";

const seed = () => {
  const { db, sqlite } = testDb();
  db.insert(user)
    .values({
      id: "u1",
      name: "T",
      email: "t@e.fi",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  db.insert(user)
    .values({
      id: "u2",
      name: "M",
      email: "m@e.fi",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  const mine = db
    .insert(accounts)
    .values({ userId: "u1", name: "Nordnet", broker: "nordnet", baseCurrency: EUR })
    .returning()
    .get();
  const theirs = db
    .insert(accounts)
    .values({ userId: "u2", name: "Toisen tili", broker: "op", baseCurrency: EUR })
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

  const buy = (accountId: number, hash: string) =>
    db
      .insert(transactions)
      .values({
        accountId,
        instrumentId: nokia.id,
        type: "BUY",
        tradeDate: "2025-01-10",
        quantity: 100_000_000,
        unitPrice: 415,
        // `amount` is the PRINCIPAL only (quantity x unit price = -415.00) --
        // `fee` (3.00) is a separate column costBasisAt adds on top (see
        // core/costbasis.test.ts's "including its fee" fixtures). The task
        // brief's original seed set this to -418.00 (principal + fee already
        // combined), which silently double-counted the fee and made the
        // brief's own expected costEur ("418.00 = 415.00 + 3.00 fee")
        // unreachable -- caught by running this test and watching it fail.
        amount: -41500,
        fee: 300,
        tax: 0,
        currency: EUR,
        fxRateEur: 100_000_000,
        contentHash: hash,
        externalId: null,
        importId: null,
      })
      .run();
  buy(mine.id, "a");
  buy(theirs.id, "b");

  db.insert(prices)
    .values([
      {
        instrumentId: nokia.id,
        date: "2025-01-10",
        close: 415,
        currency: EUR,
        source: "yahoo",
        fetchedAt: new Date(),
      },
      {
        instrumentId: nokia.id,
        date: "2025-06-02",
        close: 460,
        currency: EUR,
        source: "yahoo",
        fetchedAt: new Date(),
      },
    ])
    .run();

  return { db, sqlite, instrumentId: nokia.id, accountId: mine.id };
};

test("loads only the requesting user's rows", () => {
  const { db } = seed();
  expect(loadPortfolio(db, "u1").txns).toHaveLength(1);
  expect(loadPortfolio(db, "u2").txns).toHaveLength(1);
  expect(loadPortfolio(db, "nobody").txns).toHaveLength(0);
});

test("loads every instrument as shared reference data, not user-scoped", () => {
  const { db } = seed();
  // Neither u1 nor u2 traded anything but Nokia, but the instrument table
  // itself is shared reference data (mirrors instruments.ts's GET route),
  // so both users' loadPortfolio sees it.
  expect(loadPortfolio(db, "u1").instruments.map((i) => i.isin)).toEqual(["FI0009000681"]);
  expect(loadPortfolio(db, "nobody").instruments.map((i) => i.isin)).toEqual(["FI0009000681"]);
});

test("reconstructed transaction currency is a validated Currency, not a bare cast", () => {
  const { db } = seed();
  const [txn] = loadPortfolio(db, "u1").txns;
  expect(txn!.currency).toBe(EUR);
  expect(txn!.amount.currency).toBe(EUR);
  expect(txn!.fxRateEur.currency).toBe(EUR);
});

test("price lookup carries the latest price on or before a date", () => {
  const { db, instrumentId } = seed();
  const { prices: lookup } = loadPortfolio(db, "u1");
  expect(formatMoney(lookup.priceOn(instrumentId, "2025-03-01")!)).toBe("4.15");
  expect(formatMoney(lookup.priceOn(instrumentId, "2025-07-01")!)).toBe("4.60");
  expect(lookup.priceOn(instrumentId, "2024-12-31")).toBeNull();
});

test("price lookup reports the date a price is actually dated", () => {
  const { db, instrumentId } = seed();
  const { prices: lookup } = loadPortfolio(db, "u1");
  expect(lookup.priceDateOn(instrumentId, "2025-06-02")).toBe("2025-06-02");
  expect(lookup.priceDateOn(instrumentId, "2025-07-01")).toBe("2025-06-02");
  expect(lookup.priceDateOn(instrumentId, "2024-12-31")).toBeNull();
});

test("fx lookup returns rate 1 for EUR without a stored fx_rates row", () => {
  const { db } = seed();
  const { prices: lookup } = loadPortfolio(db, "u1");
  const rate = lookup.fxOn(EUR, "2025-06-02");
  expect(rate).not.toBeNull();
  expect(rate!.currency).toBe(EUR);
  expect(rate!.scaled).toBe(100_000_000n);
});

test("holdings carry quantity, cost, value, gain and staleness as strings", () => {
  const { db } = seed();
  const holdings = holdingsFor(db, "u1", "2025-07-01");
  expect(holdings).toHaveLength(1);
  const nokia = holdings[0]!;
  expect(nokia.name).toBe("Nokia");
  expect(nokia.quantity).toBe("100.000000");
  expect(nokia.costEur).toBe("418.00"); // 415.00 + 3.00 fee
  expect(nokia.valueEur).toBe("460.00");
  expect(nokia.unrealisedEur).toBe("42.00");
  expect(nokia.priceDate).toBe("2025-06-02");
  expect(nokia.stale).toBe(true);
});

test("holdings are exactly current, not stale, when priced on the price's own date", () => {
  const { db } = seed();
  const holdings = holdingsFor(db, "u1", "2025-06-02");
  expect(holdings[0]!.stale).toBe(false);
  expect(holdings[0]!.priceDate).toBe("2025-06-02");
});

test("a position with no price at all values at zero EUR and is reported stale", () => {
  const { db, sqlite, accountId } = seed();
  // A second instrument with no rows in `prices` at all -- distinct from
  // the "carried forward from an earlier date" staleness case above.
  // SAFETY: the preceding INSERT's own `RETURNING id` clause guarantees a
  // single row with an `id` column on success.
  const nesteAnnual = sqlite
    .query(
      "INSERT INTO instruments (isin, ticker, name, kind, currency, price_source, source_key) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .get("FI0009002377", "NESTE.HE", "Neste", "stock", "EUR", "yahoo", "NESTE.HE") as {
    id: number;
  };
  sqlite
    .query(
      "INSERT INTO transactions (account_id, instrument_id, type, trade_date, quantity, unit_price, amount, fee, tax, currency, fx_rate_eur, content_hash) VALUES (?, ?, 'BUY', '2025-02-01', 50000000, 1000, -5000, 0, 0, 'EUR', 100000000, 'neste-buy')",
    )
    .run(accountId, nesteAnnual.id);

  const holdings = holdingsFor(db, "u1", "2025-07-01");
  const neste = holdings.find((h) => h.isin === "FI0009002377")!;
  expect(neste.valueEur).toBe("0.00");
  expect(neste.priceDate).toBeNull();
  expect(neste.stale).toBe(true);
});

test("holdings are empty for a user with no accounts", () => {
  const { db } = seed();
  expect(holdingsFor(db, "nobody", "2025-07-01")).toEqual([]);
});

// --- The hard requirement: a stored currency must be re-validated, not trusted ---
//
// `db/schema.ts`'s `.$type<Currency>()` is a compile-time-only cast: nothing
// stops a row written outside the app's normal Zod-validated write paths
// (a hand edit, a future migration this code predates) from holding a
// currency string that was never run through `parseCurrency`. These tests
// insert such a row directly via raw SQL (bypassing Drizzle's own typed
// insert, which would refuse a non-Currency string at compile time) to
// prove `loadPortfolio` still catches it at read time.

test("throws when a stored transaction currency fails ISO 4217 validation", () => {
  const { db, sqlite, accountId, instrumentId } = seed();
  sqlite
    .query(
      "INSERT INTO transactions (account_id, instrument_id, type, trade_date, quantity, unit_price, amount, fee, tax, currency, fx_rate_eur, content_hash) VALUES (?, ?, 'BUY', '2025-03-01', 1000000, 100, -100, 0, 0, 'eur', 100000000, 'bad-currency')",
    )
    .run(accountId, instrumentId);

  expect(() => loadPortfolio(db, "u1")).toThrow(/Not an ISO 4217 currency code/);
});

test("throws when a stored instrument currency fails ISO 4217 validation", () => {
  const { db, sqlite } = seed();
  sqlite
    .query(
      "INSERT INTO instruments (isin, ticker, name, kind, currency, price_source, source_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run("US0000000001", "BAD", "Bad Co", "stock", "US$", "manual", "BAD");

  expect(() => loadPortfolio(db, "u1")).toThrow(/Not an ISO 4217 currency code/);
});

test("throws when a stored price currency fails ISO 4217 validation", () => {
  const { db, sqlite, instrumentId } = seed();
  sqlite
    .query(
      "INSERT INTO prices (instrument_id, date, close, currency, source, fetched_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(instrumentId, "2025-08-01", 500, "not-a-currency", "yahoo", Date.now());

  const { prices: lookup } = loadPortfolio(db, "u1");
  expect(() => lookup.priceOn(instrumentId, "2025-08-01")).toThrow(/Not an ISO 4217 currency code/);
});

test("a malformed fx_rates currency is invisible to a validated lookup rather than corrupting a rate", () => {
  const { db, sqlite } = seed();
  sqlite
    .query("INSERT INTO fx_rates (date, currency, rate_eur) VALUES (?, ?, ?)")
    .run("2025-08-01", "sek", 950_00000);

  // fxOn groups rows by currency to answer "latest rate for THIS currency
  // on or before this date" (fx_rates' primary key is (date, currency), so
  // several currencies can share a date). A validated query for "SEK"
  // therefore never matches a row stored as lowercase "sek" -- the bad row
  // is simply unreachable rather than being found and re-validated, which
  // is a safer outcome than a crash: no invalid code ever reaches an
  // FxRate either way, it just degrades to the existing "no rate yet"
  // contract instead of throwing.
  const sek = parseCurrency("SEK");
  const { prices: lookup } = loadPortfolio(db, "u1");
  expect(lookup.fxOn(sek, "2025-08-01")).toBeNull();
});
