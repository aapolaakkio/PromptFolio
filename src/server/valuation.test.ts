import { readText } from "./files.ts";
import { urlOf } from "./prices/types.ts";
import { test, expect } from "vitest";
import { EUR, formatMoney, parseCurrency } from "../core/money.ts";
import { valueSeries } from "../core/returns.ts";
import { testDb } from "./db/test-db.ts";
import { accounts, instruments, prices, transactions, user } from "./db/schema.ts";
import { backfillFxRates } from "./fx.ts";
import { ECB_DATA_URL } from "./fx-ecb.ts";
import { holdingsFor, loadPortfolio } from "./valuation.ts";

const seed = async () => {
  const { db, binding } = await testDb();
  await db
    .insert(user)
    .values({
      id: "u1",
      name: "T",
      email: "t@e.fi",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  await db
    .insert(user)
    .values({
      id: "u2",
      name: "M",
      email: "m@e.fi",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  const mine = await db
    .insert(accounts)
    .values({ userId: "u1", name: "Nordnet", broker: "nordnet", baseCurrency: EUR })
    .returning()
    .get();
  const theirs = await db
    .insert(accounts)
    .values({ userId: "u2", name: "Another account", broker: "op", baseCurrency: EUR })
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

  const buy = async (accountId: number, hash: string) =>
    await db
      .insert(transactions)
      .values({
        accountId,
        instrumentId: nokia.id,
        type: "BUY",
        tradeDate: "2025-01-10",
        quantity: 100_000_000,
        unitPrice: 415,
        // `amount` is the fee-inclusive cash total (415.00 + 3.00 = -418.00), as brokers report it; `fee` is for reporting only and must not be added again.
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
  await buy(mine.id, "a");
  await buy(theirs.id, "b");

  await db
    .insert(prices)
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

  return { db, binding, instrumentId: nokia.id, accountId: mine.id };
};

test("reads a unit price in the instrument's currency, not the row's cash currency", async () => {
  const { db, accountId } = await seed();
  const sek = await db
    .insert(instruments)
    .values({
      isin: "SE0002756973",
      ticker: null,
      name: "Swedish index fund",
      kind: "fund",
      currency: parseCurrency("SEK"),
      priceSource: "manual",
      sourceKey: "manual",
    })
    .returning()
    .get();
  // Real Nordnet shape: the fund trades in SEK, the account paid in EUR (471.67 SEK x 0.6043 units = 285 SEK = 28.00 EUR).
  await db
    .insert(transactions)
    .values({
      accountId,
      instrumentId: sek.id,
      type: "BUY",
      tradeDate: "2025-02-01",
      quantity: 604_300,
      unitPrice: 47_167,
      amount: -2800,
      fee: 0,
      tax: 0,
      currency: EUR,
      fxRateEur: 100_000_000,
      contentHash: "sek-buy",
      externalId: null,
      importId: null,
    })
    .run();

  const txn = (await loadPortfolio(db, "u1")).txns.find((t) => t.instrumentId === sek.id);
  expect(txn?.unitPrice?.currency).toBe(parseCurrency("SEK"));
  expect(txn?.amount.currency).toBe(EUR);
});

test("loads only the requesting user's rows", async () => {
  const { db } = await seed();
  expect((await loadPortfolio(db, "u1")).txns).toHaveLength(1);
  expect((await loadPortfolio(db, "u2")).txns).toHaveLength(1);
  expect((await loadPortfolio(db, "nobody")).txns).toHaveLength(0);
});

test("loads every instrument as shared reference data, not user-scoped", async () => {
  const { db } = await seed();
  // The instrument table is shared reference data, so both users' loadPortfolio sees it.
  expect((await loadPortfolio(db, "u1")).instruments.map((i) => i.isin)).toEqual(["FI0009000681"]);
  expect((await loadPortfolio(db, "nobody")).instruments.map((i) => i.isin)).toEqual([
    "FI0009000681",
  ]);
});

test("reconstructed transaction currency is a validated Currency, not a bare cast", async () => {
  const { db } = await seed();
  const [txn] = (await loadPortfolio(db, "u1")).txns;
  expect(txn!.currency).toBe(EUR);
  expect(txn!.amount.currency).toBe(EUR);
  expect(txn!.fxRateEur.currency).toBe(EUR);
});

test("price lookup carries the latest price on or before a date", async () => {
  const { db, instrumentId } = await seed();
  const { prices: lookup } = await loadPortfolio(db, "u1");
  expect(formatMoney(lookup.priceOn(instrumentId, "2025-03-01")!)).toBe("4.15");
  expect(formatMoney(lookup.priceOn(instrumentId, "2025-07-01")!)).toBe("4.60");
  expect(lookup.priceOn(instrumentId, "2024-12-31")).toBeNull();
});

test("price lookup reports the date a price is actually dated", async () => {
  const { db, instrumentId } = await seed();
  const { prices: lookup } = await loadPortfolio(db, "u1");
  expect(lookup.priceDateOn(instrumentId, "2025-06-02")).toBe("2025-06-02");
  expect(lookup.priceDateOn(instrumentId, "2025-07-01")).toBe("2025-06-02");
  expect(lookup.priceDateOn(instrumentId, "2024-12-31")).toBeNull();
});

test("fx lookup returns rate 1 for EUR without a stored fx_rates row", async () => {
  const { db } = await seed();
  const { prices: lookup } = await loadPortfolio(db, "u1");
  const rate = lookup.fxOn(EUR, "2025-06-02");
  expect(rate).not.toBeNull();
  expect(rate!.currency).toBe(EUR);
  expect(rate!.scaled).toBe(100_000_000n);
});

test("holdings carry quantity, cost, value, gain and staleness as strings", async () => {
  const { db } = await seed();
  const holdings = await holdingsFor(db, "u1", "2025-07-01");
  expect(holdings).toHaveLength(1);
  const nokia = holdings[0]!;
  expect(nokia.name).toBe("Nokia");
  expect(nokia.quantity).toBe("100.000000");
  expect(nokia.costEur).toBe("418.00"); // amount is already fee-inclusive: 415.00 principal + 3.00 fee
  expect(nokia.valueEur).toBe("460.00");
  expect(nokia.unrealisedEur).toBe("42.00");
  expect(nokia.priceDate).toBe("2025-06-02");
  expect(nokia.stale).toBe(true);
  // The only valued holding is the whole denominator: weight is exactly 1.
  expect(nokia.weight).toBe(1);
});

test("holdings carry the price source and lookup status the label shows", async () => {
  const { db } = await seed();
  const [nokia] = await holdingsFor(db, "u1", "2025-07-01");
  expect(nokia).toMatchObject({ priceSource: "yahoo", sourceKey: "NOKIA.HE", lookupStatus: "ok" });
});

// Weight is a number against the sum of holdings that COULD be valued; a second priced instrument proves the split is proportional.
test("weight is proportional to market value across multiple valued holdings, and sums to 1", async () => {
  const { db, binding, accountId } = await seed();
  // SAFETY: the INSERT's `RETURNING id` yields one row with an `id`.
  const neste = await binding
    .prepare(
      "INSERT INTO instruments (isin, ticker, name, kind, currency, price_source, source_key) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind("FI0009002377", "NESTE.HE", "Neste", "stock", "EUR", "yahoo", "NESTE.HE")
    .first<{ id: number }>();
  if (neste === null) throw new Error("insert returned no id");
  await binding
    .prepare(
      "INSERT INTO transactions (account_id, instrument_id, type, trade_date, quantity, unit_price, amount, fee, tax, currency, fx_rate_eur, content_hash) VALUES (?, ?, 'BUY', '2025-02-01', 50000000, 1000, -50000, 0, 0, 'EUR', 100000000, 'neste-buy')",
    )
    .bind(accountId, neste.id)
    .run();
  await binding
    .prepare(
      "INSERT INTO prices (instrument_id, date, close, currency, source, fetched_at) VALUES (?, '2025-06-02', 1000, 'EUR', 'yahoo', 0)",
    )
    .bind(neste.id)
    .run();

  const holdings = await holdingsFor(db, "u1", "2025-07-01");
  const nokia = holdings.find((h) => h.isin === "FI0009000681")!;
  const nesteHolding = holdings.find((h) => h.isin === "FI0009002377")!;
  // Nokia 100 x 4.60 = 460.00; Neste 50 x 10.00 = 500.00; total 960.00.
  expect(nokia.weight).toBeCloseTo(460 / 960, 10);
  expect(nesteHolding.weight).toBeCloseTo(500 / 960, 10);
  expect(nokia.weight! + nesteHolding.weight!).toBeCloseTo(1, 10);
});

test("holdings are exactly current, not stale, when priced on the price's own date", async () => {
  const { db } = await seed();
  const holdings = await holdingsFor(db, "u1", "2025-06-02");
  expect(holdings[0]!.stale).toBe(false);
  expect(holdings[0]!.priceDate).toBe("2025-06-02");
});

// A position with no price must report null `valueEur`/`unrealisedEur` plus a `valuationError`, not a fabricated 0.00 value and -50.00 loss.
test("a holding with no stored price is valued at the price it was last traded at", async () => {
  // A fund or share whose source has no history: the owner's own buy is a real price for that day.
  const { db, binding, accountId } = await seed();
  const fund = await binding
    .prepare(
      "INSERT INTO instruments (isin, ticker, name, kind, currency, price_source, source_key) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(
      "FI4000261128",
      null,
      "OP-Maailma Indeksi A",
      "fund",
      "EUR",
      "page",
      "https://www.op.fi/rahasto/op-maailma-indeksi",
    )
    .first<{ id: number }>();
  if (fund === null) throw new Error("insert returned no id");
  await binding
    .prepare(
      "INSERT INTO transactions (account_id, instrument_id, type, trade_date, quantity, unit_price, amount, fee, tax, currency, fx_rate_eur, content_hash) VALUES (?, ?, 'BUY', '2025-02-01', 2000000, 25000, -50000, 0, 0, 'EUR', 100000000, 'fund-buy')",
    )
    .bind(accountId, fund.id)
    .run();

  const { prices } = await loadPortfolio(db, "u1");
  expect(prices.priceOn(fund.id, "2025-07-01")?.minor).toBe(25000n);
  expect(prices.priceDateOn(fund.id, "2025-07-01")).toBe("2025-02-01");
  // Before the trade there is still no price at all.
  expect(prices.priceOn(fund.id, "2025-01-31")).toBeNull();
});

test("a price traded before a split is not used: it is in the old share units", async () => {
  const { db, binding, accountId } = await seed();
  const share = await binding
    .prepare(
      "INSERT INTO instruments (isin, ticker, name, kind, currency, price_source, source_key) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind("FI4000567029", "FIA1S.HE", "Finnair", "stock", "EUR", "yahoo", "FIA1S.HE")
    .first<{ id: number }>();
  if (share === null) throw new Error("insert returned no id");
  const insert = (
    date: string,
    type: string,
    quantity: number,
    unitPrice: number | null,
    hash: string,
  ) =>
    binding
      .prepare(
        "INSERT INTO transactions (account_id, instrument_id, type, trade_date, quantity, unit_price, amount, fee, tax, currency, fx_rate_eur, content_hash) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 'EUR', 100000000, ?)",
      )
      .bind(accountId, share.id, type, date, quantity, unitPrice, hash)
      .run();
  await insert("2023-01-10", "BUY", 1_000_000_000, 60, "fia-buy");
  await insert("2024-03-21", "SPLIT", 10_000_000, null, "fia-split");

  const { prices } = await loadPortfolio(db, "u1");
  expect(prices.priceOn(share.id, "2025-01-01")).toBeNull();
});

test("a position with no price at all reports no value, not a fabricated zero, and is stale", async () => {
  const { db, binding, accountId } = await seed();
  // A second instrument with no `prices` rows and no unit price on its buy: distinct from the carried-forward staleness case.
  // SAFETY: the INSERT's `RETURNING id` yields one row with an `id`.
  const nesteAnnual = await binding
    .prepare(
      "INSERT INTO instruments (isin, ticker, name, kind, currency, price_source, source_key) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind("FI0009002377", "NESTE.HE", "Neste", "stock", "EUR", "yahoo", "NESTE.HE")
    .first<{ id: number }>();
  if (nesteAnnual === null) throw new Error("insert returned no id");
  await binding
    .prepare(
      "INSERT INTO transactions (account_id, instrument_id, type, trade_date, quantity, unit_price, amount, fee, tax, currency, fx_rate_eur, content_hash) VALUES (?, ?, 'BUY', '2025-02-01', 50000000, NULL, -5000, 0, 0, 'EUR', 100000000, 'neste-buy')",
    )
    .bind(accountId, nesteAnnual.id)
    .run();

  const holdings = await holdingsFor(db, "u1", "2025-07-01");
  const neste = holdings.find((h) => h.isin === "FI0009002377")!;
  expect(neste.costEur).toBe("50.00");
  expect(neste.valueEur).toBeNull();
  expect(neste.unrealisedEur).toBeNull();
  expect(neste.priceDate).toBeNull();
  expect(neste.stale).toBe(true);
  expect(neste.valuationError).toMatch(/Neste.*FI0009002377/);
  // Unvaluable gives a null weight, not 0 (0 would read as worthless).
  expect(neste.weight).toBeNull();
  // Nokia is the whole denominator: the unpriced Neste must not dilute it.
  const nokia = holdings.find((h) => h.isin === "FI0009000681")!;
  expect(nokia.weight).toBe(1);
});

// A price dated `on` itself but quoted in SEK with no fx rate for `on` must still be unvaluable and stale (staleness is not just `priceDate !== on`).
test("a position priced today in a currency with no fx rate for today reports no value, not a fabricated zero", async () => {
  const { db, binding, accountId } = await seed();
  // SAFETY: the INSERT's `RETURNING id` yields one row with an `id`.
  const sekFund = (await binding
    .prepare(
      "INSERT INTO instruments (isin, ticker, name, kind, currency, price_source, source_key) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(
      "SE0002756973",
      null,
      "Nordnet Sverige Indeks",
      "fund",
      "SEK",
      "page",
      "https://www.nordnet.fi/rahastot/lista/nordnet-sverige",
    )
    .first()) as {
    id: number;
  };
  await binding
    .prepare(
      "INSERT INTO transactions (account_id, instrument_id, type, trade_date, quantity, unit_price, amount, fee, tax, currency, fx_rate_eur, content_hash) VALUES (?, ?, 'BUY', '2025-02-01', 100000000, 1000, -100000, 0, 0, 'EUR', 100000000, 'sek-buy')",
    )
    .bind(accountId, sekFund.id)
    .run();
  await binding
    .prepare(
      "INSERT INTO prices (instrument_id, date, close, currency, source, fetched_at) VALUES (?, '2025-07-01', 1000, 'SEK', 'page', 0)",
    )
    .bind(sekFund.id)
    .run();

  const holdings = await holdingsFor(db, "u1", "2025-07-01");
  const sek = holdings.find((h) => h.isin === "SE0002756973")!;
  expect(sek.costEur).toBe("1000.00");
  expect(sek.valueEur).toBeNull();
  expect(sek.unrealisedEur).toBeNull();
  expect(sek.priceDate).toBe("2025-07-01");
  expect(sek.stale).toBe(true);
  expect(sek.valuationError).toMatch(/SEK.*Nordnet Sverige Indeks|Nordnet Sverige Indeks.*SEK/);
  expect(sek.weight).toBeNull();
});

// --- Historical fx backfill closes the gap above ---

test("before/after: a SEK-quoted holding's historical value series is excluded (0,00 EUR) before fx history is backfilled, and a real converted figure after", async () => {
  const { db } = await testDb();
  const userId = crypto.randomUUID();
  await db
    .insert(user)
    .values({
      id: userId,
      name: "Owner",
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
  const sekFund = await db
    .insert(instruments)
    .values({
      isin: "SE0009123456",
      ticker: null,
      name: "Test fund Sweden",
      kind: "fund",
      currency: parseCurrency("SEK"),
      priceSource: "manual",
      sourceKey: "test-fund-sverige",
    })
    .returning()
    .get();
  await db
    .insert(transactions)
    .values({
      accountId: account.id,
      instrumentId: sekFund.id,
      type: "BUY",
      tradeDate: "2026-08-24",
      quantity: 100_000_000, // 100.000000 units
      unitPrice: null,
      amount: -95_000_00,
      fee: 0,
      tax: 0,
      currency: EUR,
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
      externalId: null,
      importId: null,
    })
    .run();
  await db
    .insert(prices)
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

  // BEFORE: a dated price exists but fx_rates has nothing for SEK.
  const portfolioBefore = await portfolioNow();
  const before = valueSeries(
    portfolioBefore.txns,
    portfolioBefore.instruments,
    portfolioBefore.prices,
    "2026-08-25",
    "2026-08-25",
  )[0]!;
  expect(before.excludedInstrumentIds).toEqual([sekFund.id]);
  expect(formatMoney(before.valueEur)).toBe("0.00");
  expect(before.stale).toBe(true);

  // Backfill fx history, as the nightly job and an import commit both do.
  const histFixtureText = () => readText(`${import.meta.dirname}/fixtures/ecb-sdmx-hist.csv`);
  const dispatch = async (input: string | URL | Request): Promise<Response> => {
    expect(urlOf(input).startsWith(ECB_DATA_URL)).toBe(true);
    return new Response(await histFixtureText());
  };
  const backfillResult = await backfillFxRates(db, { fetchImpl: dispatch });
  expect(backfillResult).toEqual({ inserted: 5, currencies: 1 });

  const portfolioAfter = await portfolioNow();
  const after = valueSeries(
    portfolioAfter.txns,
    portfolioAfter.instruments,
    portfolioAfter.prices,
    "2026-08-25",
    "2026-08-25",
  )[0]!;
  expect(after.excludedInstrumentIds).toEqual([]);
  expect(after.stale).toBe(false);
  // 100 units x 1000.00 SEK = 100000.00 SEK at the fixture's 2026-08-25 SEK rate (8 950 148 EUR-per-SEK, scaled 1e8) = 8950.15 EUR.
  expect(formatMoney(after.valueEur)).toBe("8950.15");
});

test("holdingsFor marks only the affected position's cost basis unknown when a sale has no matching purchase, leaving other holdings unaffected", async () => {
  const { db, binding, accountId } = await seed();
  // SAFETY: the INSERT's `RETURNING id` yields one row with an `id`.
  const broken = await binding
    .prepare(
      "INSERT INTO instruments (isin, ticker, name, kind, currency, price_source, source_key) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind("FI0009009999", "BROKEN.HE", "Broken Co", "stock", "EUR", "yahoo", "BROKEN.HE")
    .first<{ id: number }>();
  if (broken === null) throw new Error("insert returned no id");
  await binding
    .prepare(
      "INSERT INTO transactions (account_id, instrument_id, type, trade_date, quantity, unit_price, amount, fee, tax, currency, fx_rate_eur, content_hash) VALUES (?, ?, 'SELL', '2025-01-01', 5000000, 100, 500, 0, 0, 'EUR', 100000000, 'broken-sell')",
    )
    .bind(accountId, broken.id)
    .run();

  const holdings = await holdingsFor(db, "u1", "2025-07-01");
  const nokia = holdings.find((h) => h.isin === "FI0009000681")!;
  const brokenHolding = holdings.find((h) => h.isin === "FI0009009999")!;

  expect(nokia.costEur).toBe("418.00");
  expect(nokia.costBasisError).toBeNull();

  // The 5 sold units are reported, but every money field is null (not 0, not a negative).
  expect(brokenHolding.quantity).toBe("-5.000000");
  expect(brokenHolding.costEur).toBeNull();
  expect(brokenHolding.valueEur).toBeNull();
  expect(brokenHolding.unrealisedEur).toBeNull();
  expect(brokenHolding.costBasisError).not.toBeNull();
  expect(brokenHolding.costBasisError!.tradeDate).toBe("2025-01-01");
  expect(brokenHolding.costBasisError!.message).toContain("FI0009009999");
  // No weight either, and it does not dilute the valued holding.
  expect(brokenHolding.weight).toBeNull();
  expect(nokia.weight).toBe(1);
  expect(brokenHolding.costBasisError!.message).toContain("Broken Co");
});

test("holdings are empty for a user with no accounts", async () => {
  const { db } = await seed();
  expect(await holdingsFor(db, "nobody", "2025-07-01")).toEqual([]);
});

// --- A stored currency must be re-validated, not trusted: `.$type<Currency>()` is compile-time only, so a row written outside the validated paths (raw SQL here) must still be caught at read time ---

test("throws when a stored transaction currency fails ISO 4217 validation", async () => {
  const { db, binding, accountId, instrumentId } = await seed();
  await binding
    .prepare(
      "INSERT INTO transactions (account_id, instrument_id, type, trade_date, quantity, unit_price, amount, fee, tax, currency, fx_rate_eur, content_hash) VALUES (?, ?, 'BUY', '2025-03-01', 1000000, 100, -100, 0, 0, 'eur', 100000000, 'bad-currency')",
    )
    .bind(accountId, instrumentId)
    .run();

  await expect(loadPortfolio(db, "u1")).rejects.toThrow(/Not an ISO 4217 currency code/);
});

test("throws when a stored instrument currency fails ISO 4217 validation", async () => {
  const { db, binding } = await seed();
  await binding
    .prepare(
      "INSERT INTO instruments (isin, ticker, name, kind, currency, price_source, source_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind("US0000000001", "BAD", "Bad Co", "stock", "US$", "manual", "BAD")
    .run();

  await expect(loadPortfolio(db, "u1")).rejects.toThrow(/Not an ISO 4217 currency code/);
});

test("throws when a stored price currency fails ISO 4217 validation", async () => {
  const { db, binding, instrumentId } = await seed();
  await binding
    .prepare(
      "INSERT INTO prices (instrument_id, date, close, currency, source, fetched_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(instrumentId, "2025-08-01", 500, "not-a-currency", "yahoo", Date.now())
    .run();

  const { prices: lookup } = await loadPortfolio(db, "u1");
  expect(() => lookup.priceOn(instrumentId, "2025-08-01")).toThrow(/Not an ISO 4217 currency code/);
});

test("a malformed fx_rates currency is invisible to a validated lookup rather than corrupting a rate", async () => {
  const { db, binding } = await seed();
  await binding
    .prepare("INSERT INTO fx_rates (date, currency, rate_eur) VALUES (?, ?, ?)")
    .bind("2025-08-01", "sek", 950_00000)
    .run();

  // fxOn groups by currency, so a validated "SEK" query never reaches a row stored as "sek": it degrades to the "no rate yet" contract instead of throwing.
  const sek = parseCurrency("SEK");
  const { prices: lookup } = await loadPortfolio(db, "u1");
  expect(lookup.fxOn(sek, "2025-08-01")).toBeNull();
});

// Regression: ECB's dead historical endpoint once served a placeholder row dated 2010 that silently converted a 2026 holding to about five times the truth.
test("an fx rate years out of date is refused rather than carried forward", async () => {
  const { db, binding } = await seed();
  await binding
    .prepare("INSERT INTO fx_rates (date, currency, rate_eur) VALUES (?, ?, ?)")
    .bind("2010-02-14", "SEK", 50_000_000)
    .run();

  const sek = parseCurrency("SEK");
  const { prices: lookup } = await loadPortfolio(db, "u1");
  expect(lookup.fxOn(sek, "2026-08-28")).toBeNull();
});

test("a rate carried across a weekend or a holiday is still used", async () => {
  const { db, binding } = await seed();
  await binding
    .prepare("INSERT INTO fx_rates (date, currency, rate_eur) VALUES (?, ?, ?)")
    .bind("2026-08-21", "SEK", 9_000_000)
    .run();

  const sek = parseCurrency("SEK");
  const { prices: lookup } = await loadPortfolio(db, "u1");
  expect(lookup.fxOn(sek, "2026-08-25")).not.toBeNull();
  // Eleven days on: past the bound, so unvaluable rather than guessed.
  expect(lookup.fxOn(sek, "2026-09-01")).toBeNull();
});
