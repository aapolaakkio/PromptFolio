import { test, expect } from "bun:test";
import { EUR, formatMoney, parseCurrency } from "../core/money";
import { valueSeries } from "../core/returns";
import { testDb } from "./db";
import { accounts, instruments, prices, transactions, user } from "./db/schema";
import { backfillFxRates } from "./fx";
import { ECB_DATA_URL } from "./fx-ecb";
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
        // `amount` is the fee-inclusive total cash that moved (principal
        // 415.00 + fee 3.00 = -418.00) -- see `Txn.amount`'s doc in
        // core/types.ts, and C2 in the phase-1 review: an earlier version of
        // this seed set `amount` to the principal alone and let
        // `costBasisAt` add `fee` on top, which is exactly the double-count
        // bug real OP/Nordnet fixtures exposed (both brokers report a
        // fee-inclusive total, never principal-only). `fee` is carried here
        // purely for reporting; it must not be added to `amount` again.
        amount: -41800,
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
  expect(nokia.costEur).toBe("418.00"); // amount is already fee-inclusive: 415.00 principal + 3.00 fee
  expect(nokia.valueEur).toBe("460.00");
  expect(nokia.unrealisedEur).toBe("42.00");
  expect(nokia.priceDate).toBe("2025-06-02");
  expect(nokia.stale).toBe(true);
  // The only valued holding in the portfolio -- it is the entire denominator,
  // so its own share of it is exactly 1 (100%).
  expect(nokia.weight).toBe(1);
});

// Weight is a ratio (a number on the wire, like allocation.ts's own `weight`), never a
// decimal string, and is computed against the sum of holdings that COULD be valued --
// not every holding the ledger knows about. A second, independently priced instrument
// alongside Nokia proves the split is proportional, not just "1 when alone".
test("weight is proportional to market value across multiple valued holdings, and sums to 1", () => {
  const { db, sqlite, accountId } = seed();
  // SAFETY: the preceding INSERT's own `RETURNING id` clause guarantees a
  // single row with an `id` column on success.
  const neste = sqlite
    .query(
      "INSERT INTO instruments (isin, ticker, name, kind, currency, price_source, source_key) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .get("FI0009002377", "NESTE.HE", "Neste", "stock", "EUR", "yahoo", "NESTE.HE") as {
    id: number;
  };
  sqlite
    .query(
      "INSERT INTO transactions (account_id, instrument_id, type, trade_date, quantity, unit_price, amount, fee, tax, currency, fx_rate_eur, content_hash) VALUES (?, ?, 'BUY', '2025-02-01', 50000000, 1000, -50000, 0, 0, 'EUR', 100000000, 'neste-buy')",
    )
    .run(accountId, neste.id);
  sqlite
    .query(
      "INSERT INTO prices (instrument_id, date, close, currency, source, fetched_at) VALUES (?, '2025-06-02', 1000, 'EUR', 'yahoo', 0)",
    )
    .run(neste.id);

  const holdings = holdingsFor(db, "u1", "2025-07-01");
  const nokia = holdings.find((h) => h.isin === "FI0009000681")!;
  const nesteHolding = holdings.find((h) => h.isin === "FI0009002377")!;
  // Nokia: 100.000000 units at 4.60 EUR/unit = 460.00. Neste: 50.000000 units at
  // 10.00 EUR/unit = 500.00. Total = 960.00 -> Nokia 460/960, Neste 500/960.
  expect(nokia.weight).toBeCloseTo(460 / 960, 10);
  expect(nesteHolding.weight).toBeCloseTo(500 / 960, 10);
  expect(nokia.weight! + nesteHolding.weight!).toBeCloseTo(1, 10);
});

test("holdings are exactly current, not stale, when priced on the price's own date", () => {
  const { db } = seed();
  const holdings = holdingsFor(db, "u1", "2025-06-02");
  expect(holdings[0]!.stale).toBe(false);
  expect(holdings[0]!.priceDate).toBe("2025-06-02");
});

// C1: a position with no price at all used to report a fabricated "0.00" market value
// (and a matching, equally fabricated "-50.00" loss) -- a plausible-looking but entirely
// invented number, since there is nothing to value this holding at. It must instead
// report `valueEur`/`unrealisedEur` as null, with `valuationError` saying why, exactly
// like `costBasisError` already does for an unmatched disposal (see HoldingView's doc).
test("a position with no price at all reports no value, not a fabricated zero, and is stale", () => {
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
  // Cost basis is still known -- it doesn't depend on today's price -- so it stays.
  expect(neste.costEur).toBe("50.00");
  expect(neste.valueEur).toBeNull();
  expect(neste.unrealisedEur).toBeNull();
  expect(neste.priceDate).toBeNull();
  expect(neste.stale).toBe(true);
  expect(neste.valuationError).toMatch(/Neste.*FI0009002377/);
  // Cannot be valued -> no meaningful weight either (null, not 0 -- 0 would
  // read as "this is worthless", not "this is unknown").
  expect(neste.weight).toBeNull();
  // Nokia is the only holding that COULD be valued, so it is the entire
  // denominator: the un-priced Neste position must not silently dilute it.
  const nokia = holdings.find((h) => h.isin === "FI0009000681")!;
  expect(nokia.weight).toBe(1);
});

// C1's exact reproduction: a real price row dated `on` itself (so the OLD staleness
// check, `priceDate !== on` alone, reports `false`), but the instrument prices in a
// non-EUR currency with no fx rate known for `on` -- a EUR-booked, SEK-quoted fund is
// the real case this came from (see fx.ts). Must still report no value and be stale.
test("a position priced today in a currency with no fx rate for today reports no value, not a fabricated zero", () => {
  const { db, sqlite, accountId } = seed();
  // SAFETY: the preceding INSERT's own `RETURNING id` clause guarantees a
  // single row with an `id` column on success.
  const sekFund = sqlite
    .query(
      "INSERT INTO instruments (isin, ticker, name, kind, currency, price_source, source_key) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .get(
      "SE0002756973",
      null,
      "Nordnet Sverige Indeks",
      "fund",
      "SEK",
      "nordnet_fund",
      "nordnet-sverige",
    ) as {
    id: number;
  };
  sqlite
    .query(
      "INSERT INTO transactions (account_id, instrument_id, type, trade_date, quantity, unit_price, amount, fee, tax, currency, fx_rate_eur, content_hash) VALUES (?, ?, 'BUY', '2025-02-01', 100000000, 1000, -100000, 0, 0, 'EUR', 100000000, 'sek-buy')",
    )
    .run(accountId, sekFund.id);
  sqlite
    .query(
      "INSERT INTO prices (instrument_id, date, close, currency, source, fetched_at) VALUES (?, '2025-07-01', 1000, 'SEK', 'nordnet_fund', 0)",
    )
    .run(sekFund.id);
  // Deliberately no fx_rates row for SEK at all -- the exact C1 deadlock/gap.

  const holdings = holdingsFor(db, "u1", "2025-07-01");
  const sek = holdings.find((h) => h.isin === "SE0002756973")!;
  expect(sek.costEur).toBe("1000.00");
  expect(sek.valueEur).toBeNull();
  expect(sek.unrealisedEur).toBeNull();
  // The price IS dated exactly `on` -- proves staleness isn't just `priceDate !== on`.
  expect(sek.priceDate).toBe("2025-07-01");
  expect(sek.stale).toBe(true);
  expect(sek.valuationError).toMatch(/SEK.*Nordnet Sverige Indeks|Nordnet Sverige Indeks.*SEK/);
  // A known price but no fx rate is still "cannot be valued" -- no weight either.
  expect(sek.weight).toBeNull();
});

// --- Historical-fx fix: the gap above closes once fx.ts's historical backfill runs ---
// (a fresh ISIN here, not SE0002756973 -- that one is this file's own fixture above)

test("before/after: a SEK-quoted holding's historical value series is excluded (0,00 EUR) before fx history is backfilled, and a real converted figure after", async () => {
  const { db } = testDb();
  const userId = crypto.randomUUID();
  db.insert(user)
    .values({
      id: userId,
      name: "Omistaja",
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
  const sekFund = db
    .insert(instruments)
    .values({
      isin: "SE0009123456",
      ticker: null,
      name: "Testirahasto Ruotsi",
      kind: "fund",
      currency: parseCurrency("SEK"),
      priceSource: "manual",
      sourceKey: "testirahasto-sverige",
    })
    .returning()
    .get();
  db.insert(transactions)
    .values({
      accountId: account.id,
      instrumentId: sekFund.id,
      type: "BUY",
      tradeDate: "2026-08-24", // matches a real row in the recorded hist fixture
      quantity: 100_000_000, // 100.000000 units
      unitPrice: null,
      amount: -95_000_00, // informational only -- valueSeries never reads unitPrice/amount
      fee: 0,
      tax: 0,
      currency: EUR, // the cash that moved was EUR -- §10a A2/A5
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
      externalId: null,
      importId: null,
    })
    .run();
  db.insert(prices)
    .values({
      instrumentId: sekFund.id,
      date: "2026-08-25",
      close: 100_000, // 1 000,00 SEK per unit
      currency: parseCurrency("SEK"),
      source: "manual",
      fetchedAt: new Date(),
    })
    .run();

  const portfolioNow = () => loadPortfolio(db, userId);

  // BEFORE: exactly §10a's confirmed gap -- a real, dated price exists, but fx_rates has
  // nothing for SEK at all yet (only the ECB *current* daily rate has ever been ingested).
  const before = valueSeries(
    portfolioNow().txns,
    portfolioNow().instruments,
    portfolioNow().prices,
    "2026-08-25",
    "2026-08-25",
  )[0]!;
  expect(before.excludedInstrumentIds).toEqual([sekFund.id]);
  expect(formatMoney(before.valueEur)).toBe("0.00");
  expect(before.stale).toBe(true);

  // Backfill fx history -- exactly what the nightly job (`runScheduledRefresh`) and a
  // fresh import commit (`backfillCommittedInstruments`) now both trigger.
  const histFixtureText = () => Bun.file(`${import.meta.dir}/fixtures/ecb-sdmx-hist.csv`).text();
  const dispatch = async (input: string | URL | Request): Promise<Response> => {
    expect(String(input)).toStartWith(ECB_DATA_URL);
    return new Response(await histFixtureText());
  };
  const backfillResult = await backfillFxRates(db, { fetchImpl: dispatch });
  expect(backfillResult).toEqual({ inserted: 5, currencies: 1 });

  // AFTER: same date, same price, now a real converted EUR value.
  const after = valueSeries(
    portfolioNow().txns,
    portfolioNow().instruments,
    portfolioNow().prices,
    "2026-08-25",
    "2026-08-25",
  )[0]!;
  expect(after.excludedInstrumentIds).toEqual([]);
  expect(after.stale).toBe(false);
  // 100.000000 units * 1 000,00 SEK = 100 000,00 SEK, converted at the fixture's real
  // 2026-08-25 SEK rate (8 950 148 EUR-per-SEK, scaled 1e8) via core/money.ts's own
  // mulMoney/toEur (exact bigint, half-up) = 8 950,15 EUR exactly.
  expect(formatMoney(after.valueEur)).toBe("8950.15");
});

test("holdingsFor marks only the affected position's cost basis unknown when a sale has no matching purchase, leaving other holdings unaffected", () => {
  const { db, sqlite, accountId } = seed();
  // SAFETY: the preceding INSERT's own `RETURNING id` clause guarantees a
  // single row with an `id` column on success.
  const broken = sqlite
    .query(
      "INSERT INTO instruments (isin, ticker, name, kind, currency, price_source, source_key) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .get("FI0009009999", "BROKEN.HE", "Broken Co", "stock", "EUR", "yahoo", "BROKEN.HE") as {
    id: number;
  };
  sqlite
    .query(
      "INSERT INTO transactions (account_id, instrument_id, type, trade_date, quantity, unit_price, amount, fee, tax, currency, fx_rate_eur, content_hash) VALUES (?, ?, 'SELL', '2025-01-01', 5000000, 100, 500, 0, 0, 'EUR', 100000000, 'broken-sell')",
    )
    .run(accountId, broken.id);

  const holdings = holdingsFor(db, "u1", "2025-07-01");
  const nokia = holdings.find((h) => h.isin === "FI0009000681")!;
  const brokenHolding = holdings.find((h) => h.isin === "FI0009009999")!;

  // The ordinary Nokia holding still gets a real cost basis, unaffected by the
  // other instrument's incomplete ledger.
  expect(nokia.costEur).toBe("418.00");
  expect(nokia.costBasisError).toBeNull();

  // The 5 sold units are still reported honestly (the raw ledger fact), but
  // every money field is null, not zero and not a fabricated negative amount.
  expect(brokenHolding.quantity).toBe("-5.000000");
  expect(brokenHolding.costEur).toBeNull();
  expect(brokenHolding.valueEur).toBeNull();
  expect(brokenHolding.unrealisedEur).toBeNull();
  expect(brokenHolding.costBasisError).not.toBeNull();
  expect(brokenHolding.costBasisError!.tradeDate).toBe("2025-01-01");
  expect(brokenHolding.costBasisError!.message).toContain("FI0009009999");
  // An unmatched disposal has no meaningful weight either -- and does not
  // dilute the one holding that COULD be valued.
  expect(brokenHolding.weight).toBeNull();
  expect(nokia.weight).toBe(1);
  expect(brokenHolding.costBasisError!.message).toContain("Broken Co");
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
