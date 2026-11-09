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
    .values({ userId: "u2", name: "Toisen tili", broker: "op", baseCurrency: EUR })
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
      name: "Ruotsalainen indeksirahasto",
      kind: "fund",
      currency: parseCurrency("SEK"),
      priceSource: "manual",
      sourceKey: "manual",
    })
    .returning()
    .get();
  // A real Nordnet shape: the fund trades in SEK, the account paid in EUR.
  // 0,6043 units at 471,67 SEK is 285 SEK, which is the 28,00 EUR that left
  // the account -- so the price is SEK and the amount is EUR.
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
  // Neither u1 nor u2 traded anything but Nokia, but the instrument table
  // itself is shared reference data (mirrors instruments.ts's GET route),
  // so both users' loadPortfolio sees it.
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
  // The only valued holding in the portfolio -- it is the entire denominator,
  // so its own share of it is exactly 1 (100%).
  expect(nokia.weight).toBe(1);
});

test("holdings carry the price source and lookup status the label shows", async () => {
  const { db } = await seed();
  const [nokia] = await holdingsFor(db, "u1", "2025-07-01");
  expect(nokia).toMatchObject({ priceSource: "yahoo", sourceKey: "NOKIA.HE", lookupStatus: "ok" });
});

// Weight is a ratio (a number on the wire, like allocation.ts's own `weight`), never a
// decimal string, and is computed against the sum of holdings that COULD be valued --
// not every holding the ledger knows about. A second, independently priced instrument
// alongside Nokia proves the split is proportional, not just "1 when alone".
test("weight is proportional to market value across multiple valued holdings, and sums to 1", async () => {
  const { db, binding, accountId } = await seed();
  // SAFETY: the preceding INSERT's own `RETURNING id` clause guarantees a
  // single row with an `id` column on success.
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
  // Nokia: 100.000000 units at 4.60 EUR/unit = 460.00. Neste: 50.000000 units at
  // 10.00 EUR/unit = 500.00. Total = 960.00 -> Nokia 460/960, Neste 500/960.
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

// C1: a position with no price at all used to report a fabricated "0.00" market value
// (and a matching, equally fabricated "-50.00" loss) -- a plausible-looking but entirely
// invented number, since there is nothing to value this holding at. It must instead
// report `valueEur`/`unrealisedEur` as null, with `valuationError` saying why, exactly
// like `costBasisError` already does for an unmatched disposal (see HoldingView's doc).
test("a holding with no stored price is valued at the price it was last traded at", async () => {
  // A fund whose source serves only its latest value, or a share whose source
  // refuses requests: the owner's own buy is a real price for that day.
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
      "op_fund",
      "op-maailma-indeksi",
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
  // A second instrument with no rows in `prices` at all, bought on a row that
  // states no unit price either -- distinct from the "carried forward from an
  // earlier date" staleness case above, and from a traded price (below).
  // SAFETY: the preceding INSERT's own `RETURNING id` clause guarantees a
  // single row with an `id` column on success.
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
test("a position priced today in a currency with no fx rate for today reports no value, not a fabricated zero", async () => {
  const { db, binding, accountId } = await seed();
  // SAFETY: the preceding INSERT's own `RETURNING id` clause guarantees a
  // single row with an `id` column on success.
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
      "nordnet_fund",
      "nordnet-sverige",
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
      "INSERT INTO prices (instrument_id, date, close, currency, source, fetched_at) VALUES (?, '2025-07-01', 1000, 'SEK', 'nordnet_fund', 0)",
    )
    .bind(sekFund.id)
    .run();
  // Deliberately no fx_rates row for SEK at all -- the exact C1 deadlock/gap.

  const holdings = await holdingsFor(db, "u1", "2025-07-01");
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
  const { db } = await testDb();
  const userId = crypto.randomUUID();
  await db
    .insert(user)
    .values({
      id: userId,
      name: "Omistaja",
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
      name: "Testirahasto Ruotsi",
      kind: "fund",
      currency: parseCurrency("SEK"),
      priceSource: "manual",
      sourceKey: "testirahasto-sverige",
    })
    .returning()
    .get();
  await db
    .insert(transactions)
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

  // Re-read rather than reused: the whole point is that the same query gives a
  // different answer once the FX history below lands.
  const portfolioNow = () => loadPortfolio(db, userId);

  // BEFORE: exactly §10a's confirmed gap -- a real, dated price exists, but fx_rates has
  // nothing for SEK at all yet (only the ECB *current* daily rate has ever been ingested).
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

  // Backfill fx history -- exactly what the nightly job (`runScheduledRefresh`) and a
  // fresh import commit (`backfillCommittedInstruments`) now both trigger.
  const histFixtureText = () => readText(`${import.meta.dirname}/fixtures/ecb-sdmx-hist.csv`);
  const dispatch = async (input: string | URL | Request): Promise<Response> => {
    expect(urlOf(input).startsWith(ECB_DATA_URL)).toBe(true);
    return new Response(await histFixtureText());
  };
  const backfillResult = await backfillFxRates(db, { fetchImpl: dispatch });
  expect(backfillResult).toEqual({ inserted: 5, currencies: 1 });

  // AFTER: same date, same price, now a real converted EUR value.
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
  // 100.000000 units * 1 000,00 SEK = 100 000,00 SEK, converted at the fixture's real
  // 2026-08-25 SEK rate (8 950 148 EUR-per-SEK, scaled 1e8) via core/money.ts's own
  // mulMoney/toEur (exact bigint, half-up) = 8 950,15 EUR exactly.
  expect(formatMoney(after.valueEur)).toBe("8950.15");
});

test("holdingsFor marks only the affected position's cost basis unknown when a sale has no matching purchase, leaving other holdings unaffected", async () => {
  const { db, binding, accountId } = await seed();
  // SAFETY: the preceding INSERT's own `RETURNING id` clause guarantees a
  // single row with an `id` column on success.
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

test("holdings are empty for a user with no accounts", async () => {
  const { db } = await seed();
  expect(await holdingsFor(db, "nobody", "2025-07-01")).toEqual([]);
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

  // fxOn groups rows by currency to answer "latest rate for THIS currency
  // on or before this date" (fx_rates' primary key is (date, currency), so
  // several currencies can share a date). A validated query for "SEK"
  // therefore never matches a row stored as lowercase "sek" -- the bad row
  // is simply unreachable rather than being found and re-validated, which
  // is a safer outcome than a crash: no invalid code ever reaches an
  // FxRate either way, it just degrades to the existing "no rate yet"
  // contract instead of throwing.
  const sek = parseCurrency("SEK");
  const { prices: lookup } = await loadPortfolio(db, "u1");
  expect(lookup.fxOn(sek, "2025-08-01")).toBeNull();
});

// The failure this bound exists for, reproduced: ECB's dead historical endpoint
// once served a placeholder row dated 2010, and it converted a 2026 holding
// silently. The arithmetic was sound, so the result read as a real number --
// about five times the truth.
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
  // Four days on: an ordinary long weekend, well inside the bound.
  expect(lookup.fxOn(sek, "2026-08-25")).not.toBeNull();
  // Eleven days on: past it, and a valuation that far from a published rate is
  // reported as unvaluable rather than guessed.
  expect(lookup.fxOn(sek, "2026-09-01")).toBeNull();
});
