import { expect, test } from "bun:test";

import { EUR, parseCurrency, type Currency } from "../core/money";
import { testDb } from "./db";
import { accounts, fxRates, instruments, transactions, user } from "./db/schema";
import { ECB_URL, ensureFxRate, fxRateOn, parseEcbCsv, refreshFxRates } from "./fx";

const SEK = parseCurrency("SEK");

const fixtureText = () => Bun.file(`${import.meta.dir}/fixtures/ecb-eurofxref.csv`).text();

/**
 * Independently computed (Python `Decimal`, not this project's own code)
 * from the fixture's raw ECB cells, so these are an oracle, not a
 * tautology against `parseEcbCsv`'s own arithmetic. USD's value matches
 * the design doc's own worked example (1 EUR = 1.0870 USD -> 91_996_320).
 */
type OracleCurrency = "USD" | "JPY" | "GBP" | "SEK" | "NOK";

const EXPECTED_RATE_EUR = {
  USD: 91_996_320,
  JPY: 631_233,
  GBP: 118_877_794,
  SEK: 8_901_549,
  NOK: 8_645_284,
} satisfies Record<OracleCurrency, number>;

const isOracleCurrency = (value: string): value is OracleCurrency =>
  value === "USD" || value === "JPY" || value === "GBP" || value === "SEK" || value === "NOK";

/** `EXPECTED_RATE_EUR[currency]`, but fails loudly instead of typing as possibly-`undefined`. */
const expectedRate = (currency: string): number => {
  if (!isOracleCurrency(currency)) throw new Error(`no oracle rate recorded for ${currency}`);
  return EXPECTED_RATE_EUR[currency];
};

/** Seeds one ledger transaction in `currency`, with the user/account it needs to satisfy FKs. */
const seedTransaction = (db: ReturnType<typeof testDb>["db"], currency: Currency) => {
  const userId = crypto.randomUUID();
  db.insert(user)
    .values({
      id: userId,
      name: "Testikäyttäjä",
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
  db.insert(transactions)
    .values({
      accountId: account.id,
      type: "DEPOSIT",
      tradeDate: "2026-01-01",
      currency,
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
    })
    .run();
};

// --- parseEcbCsv -----------------------------------------------------------

test("inverts the ECB rate (foreign-per-EUR) to EUR-per-foreign, scaled 1e8", async () => {
  const parsed = parseEcbCsv(await fixtureText(), new Set(["USD"]));
  expect(parsed).toHaveLength(1);
  expect(parsed[0]).toEqual({
    date: "2026-08-27",
    currency: parseCurrency("USD"),
    rateEur: expectedRate("USD"),
  });
});

test("returns exactly the wanted currencies, ignoring the rest of the row", async () => {
  const parsed = parseEcbCsv(await fixtureText(), new Set(["SEK"]));
  expect(parsed).toEqual([
    { date: "2026-08-27", currency: parseCurrency("SEK"), rateEur: expectedRate("SEK") },
  ]);
});

test("returns every wanted currency present, each inverted correctly", async () => {
  const parsed = parseEcbCsv(await fixtureText(), new Set(["USD", "JPY", "GBP", "SEK", "NOK"]));
  expect(parsed).toHaveLength(5);
  for (const row of parsed) {
    expect(row.rateEur).toBe(expectedRate(row.currency));
  }
});

test("rejects a file whose header is not the ECB layout", () => {
  expect(() => parseEcbCsv("nope\n1;2\n", new Set(["USD"]))).toThrow(/ECB/i);
});

test("never returns EUR, even if a caller's wanted set asks for it", () => {
  // Synthetic: the real ECB file has no EUR column (EUR is its implicit
  // base), but this proves the guard holds even against a malformed or
  // future file that did carry one.
  const withEurColumn = "Date, EUR, USD\n27 August 2026, 1.0000, 1.0870\n";
  const parsed = parseEcbCsv(withEurColumn, new Set(["EUR", "USD"]));
  expect(parsed.map((row) => row.currency)).toEqual([parseCurrency("USD")]);
});

test("skips a single unparseable rate cell instead of failing the whole file", () => {
  const withNA = "Date, USD, JPY\n27 August 2026, N/A, 158.42\n";
  const parsed = parseEcbCsv(withNA, new Set(["USD", "JPY"]));
  expect(parsed).toEqual([
    { date: "2026-08-27", currency: parseCurrency("JPY"), rateEur: expectedRate("JPY") },
  ]);
});

test("rejects an unparseable date instead of guessing", () => {
  const badDate = "Date, USD\n32 Somemonth 2026, 1.0870\n";
  expect(() => parseEcbCsv(badDate, new Set(["USD"]))).toThrow(/ECB/i);
});

// --- refreshFxRates ----------------------------------------------------------

test("fetches nothing and touches no network when the ledger holds no foreign currency", async () => {
  const { db } = testDb();
  const mustNotBeCalled = (): Promise<Response> => {
    throw new Error("must not be called");
  };
  const result = await refreshFxRates(db, { fetchImpl: mustNotBeCalled });
  expect(result).toEqual({ inserted: 0 });
  expect(db.select().from(fxRates).all()).toEqual([]);
});

test("fetches nothing when the ledger only ever traded in EUR", async () => {
  const { db } = testDb();
  seedTransaction(db, EUR);
  const mustNotBeCalled = (): Promise<Response> => {
    throw new Error("must not be called");
  };
  const result = await refreshFxRates(db, { fetchImpl: mustNotBeCalled });
  expect(result).toEqual({ inserted: 0 });
});

test("fetches exactly the ledger's held currency (SEK), never defaulting to USD", async () => {
  const { db } = testDb();
  seedTransaction(db, SEK);
  const stub = async (url: string | URL | Request): Promise<Response> => {
    expect(String(url)).toBe(ECB_URL);
    return new Response(await fixtureText());
  };
  const result = await refreshFxRates(db, { fetchImpl: stub });
  expect(result).toEqual({ inserted: 1 });
  const rows = db.select().from(fxRates).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ currency: "SEK", rateEur: EXPECTED_RATE_EUR.SEK });
});

test("stores rates idempotently: a second run for the same date inserts nothing new", async () => {
  const { db } = testDb();
  seedTransaction(db, SEK);
  const stub = async (): Promise<Response> => new Response(await fixtureText());
  expect((await refreshFxRates(db, { fetchImpl: stub })).inserted).toBe(1);
  expect((await refreshFxRates(db, { fetchImpl: stub })).inserted).toBe(0);
  expect(db.select().from(fxRates).all()).toHaveLength(1);
});

test("never inserts an EUR row, even for a ledger holding a currency alongside EUR deposits", async () => {
  const { db } = testDb();
  seedTransaction(db, SEK);
  seedTransaction(db, EUR);
  const stub = async (): Promise<Response> => new Response(await fixtureText());
  await refreshFxRates(db, { fetchImpl: stub });
  const rows = db.select().from(fxRates).all();
  expect(rows.every((row) => row.currency !== "EUR")).toBe(true);
});

test("surfaces a non-OK ECB response as a thrown error instead of silently storing nothing", async () => {
  const { db } = testDb();
  seedTransaction(db, SEK);
  const failing = async (): Promise<Response> =>
    new Response("down", { status: 503, statusText: "Service Unavailable" });
  await expect(refreshFxRates(db, { fetchImpl: failing })).rejects.toThrow(/503/);
});

// --- C1: currencies sourced from instruments too, not just transactions.currency ------

test("fetches a currency held only by an instrument's own quotation currency, with no matching transaction currency at all", async () => {
  // Reproduces C1 exactly: a fund whose transactions are booked in EUR (§10a A2/A5 --
  // the cash that moved was EUR) but whose price/NAV is quoted in SEK. Before this fix,
  // SEK never appeared in `transactions.currency`, so its rate was never fetched even
  // though the instrument plainly needs one to be valued.
  const { db } = testDb();
  seedTransaction(db, EUR); // only ever a EUR transaction -- no SEK row anywhere
  db.insert(instruments)
    .values({
      isin: "SE0002756973",
      ticker: null,
      name: "Nordnet Sverige Indeks",
      kind: "fund",
      currency: SEK,
      priceSource: "nordnet_fund",
      sourceKey: "nordnet-sverige",
    })
    .run();
  const stub = async (): Promise<Response> => new Response(await fixtureText());
  const result = await refreshFxRates(db, { fetchImpl: stub });
  expect(result).toEqual({ inserted: 1 });
  const rows = db.select().from(fxRates).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ currency: "SEK", rateEur: EXPECTED_RATE_EUR.SEK });
});

test("unions transaction and instrument currencies without fetching a currency twice", async () => {
  const { db } = testDb();
  seedTransaction(db, SEK);
  db.insert(instruments)
    .values({
      isin: "SE0002756973",
      ticker: null,
      name: "Nordnet Sverige Indeks",
      kind: "fund",
      currency: SEK, // same currency the transaction already carries
      priceSource: "nordnet_fund",
      sourceKey: "nordnet-sverige",
    })
    .run();
  let calls = 0;
  const stub = async (): Promise<Response> => {
    calls++;
    return new Response(await fixtureText());
  };
  const result = await refreshFxRates(db, { fetchImpl: stub });
  expect(calls).toBe(1); // one ECB fetch, not one per source of the currency
  expect(result).toEqual({ inserted: 1 });
});

// --- C1b: fxRateOn / ensureFxRate -- breaks the "first non-EUR transaction" deadlock ---

test("fxRateOn returns null with no matching row, and the newest row on or before the date otherwise", () => {
  const { db } = testDb();
  db.insert(fxRates)
    .values([
      { date: "2026-08-20", currency: SEK, rateEur: 9_000_000 },
      { date: "2026-08-25", currency: SEK, rateEur: 9_100_000 },
    ])
    .run();
  expect(fxRateOn(db, SEK, "2026-08-19")).toBeNull();
  expect(fxRateOn(db, SEK, "2026-08-22")).toBe(9_000_000);
  expect(fxRateOn(db, SEK, "2026-08-30")).toBe(9_100_000);
});

test("ensureFxRate returns the existing rate without ever calling fetchImpl", async () => {
  const { db } = testDb();
  db.insert(fxRates).values({ date: "2026-08-20", currency: SEK, rateEur: 9_000_000 }).run();
  const mustNotBeCalled = (): Promise<Response> => {
    throw new Error("must not be called");
  };
  const rate = await ensureFxRate(db, SEK, "2026-08-22", mustNotBeCalled);
  expect(rate).toBe(9_000_000);
});

test("ensureFxRate fetches and stores ECB's rate on demand when nothing exists yet, breaking the deadlock", async () => {
  const { db } = testDb();
  // No fx_rates row at all -- exactly the deadlock: refreshFxRates() never fetches a
  // currency the ledger doesn't hold yet, and this currency's first transaction is
  // exactly what would introduce it.
  const stub = async (): Promise<Response> => new Response(await fixtureText());
  const rate = await ensureFxRate(db, SEK, "2026-08-27", stub);
  expect(rate).toBe(EXPECTED_RATE_EUR.SEK);
  expect(db.select().from(fxRates).all()).toHaveLength(1);
});

test("ensureFxRate returns null (not a thrown error) when ECB has nothing to offer for this date -- the fetched rate is later than the row's own date", async () => {
  // ECB's daily file has no history -- it can only ever satisfy `date`s on or after
  // its own published date. A genuinely back-dated row stays unresolved.
  const { db } = testDb();
  const stub = async (): Promise<Response> => new Response(await fixtureText()); // dated 2026-08-27
  const rate = await ensureFxRate(db, SEK, "2020-01-01", stub);
  expect(rate).toBeNull();
  // Still stores what it fetched, so a later row on/after that date benefits for free.
  expect(db.select().from(fxRates).all()).toHaveLength(1);
});

test("ensureFxRate swallows a fetch failure to null instead of throwing out of a commit", async () => {
  const { db } = testDb();
  const failing = async (): Promise<Response> =>
    new Response("down", { status: 503, statusText: "Service Unavailable" });
  const rate = await ensureFxRate(db, SEK, "2026-08-27", failing);
  expect(rate).toBeNull();
  expect(db.select().from(fxRates).all()).toEqual([]);
});
