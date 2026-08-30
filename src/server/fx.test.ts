import { readText } from "./files";
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { EUR, parseCurrency, type Currency } from "../core/money";
import { testDb } from "./db";
import { accounts, fxRates, instruments, transactions, user } from "./db/schema";
import { backfillFxRates, ensureFxRate, fxRateOn, refreshFxRates } from "./fx";
import { ECB_DATA_URL, ecbSeriesUrl, parseEcbSdmxCsv } from "./fx-ecb";
import type { FetchImpl } from "./prices/types";

const SEK = parseCurrency("SEK");
const USD = parseCurrency("USD");

/**
 * ECB's SDMX `csvdata` responses, recorded in the shape a real fetch returns (see
 * fx-ecb.ts for why the flat CSV files this used to read are unusable). `fixtureText`
 * carries one day, `histFixtureText` the same five days the ledger tests range over --
 * the rates are unchanged from the earlier fixtures, so every expected value below still
 * describes the same arithmetic.
 */
const fixtureText = () => readText(`${import.meta.dir}/fixtures/ecb-sdmx-daily.csv`);
const histFixtureText = () => readText(`${import.meta.dir}/fixtures/ecb-sdmx-hist.csv`);

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

/**
 * The trimmed `ecb-eurofxref-hist.csv` fixture's own oracle, one row per date it carries,
 * newest first -- independently computed the same way as `EXPECTED_RATE_EUR` above (the
 * documented formula: `parseFxRate`'s scale-1e8 parse, then `invertScaledRate`'s
 * `1e16/scaled` half-up), not by calling `parseEcbHistCsv` itself. 2026-08-27's row is
 * deliberately identical to the daily fixture's own single row (same date, same values),
 * so a lookup on that date resolves to the same rate through either file -- asserted
 * directly below.
 *
 * The big gap between 2026-08-24 and 2020-01-02 is deliberate, not an oversight: it is what
 * lets a test prove `parseEcbHistCsv`'s `since` boundary (one row kept just *before* the
 * cutoff, for `fxRateOn`'s "on or before" fallback) without needing a full, multi-thousand-
 * row recording of the real file -- see this file's own report for exactly what was trimmed
 * from the real fetch.
 */
const HIST_EXPECTED_RATE_EUR = {
  "2026-08-27": { USD: 91_996_320, JPY: 631_233, GBP: 118_877_794, SEK: 8_901_549, NOK: 8_645_284 },
  "2026-08-26": { USD: 92_123_445, JPY: 632_711, GBP: 119_061_793, SEK: 8_930_166, NOK: 8_665_511 },
  "2026-08-25": { USD: 92_250_923, JPY: 634_115, GBP: 119_260_584, SEK: 8_950_148, NOK: 8_684_325 },
  "2026-08-24": { USD: 92_378_753, JPY: 635_526, GBP: 119_460_041, SEK: 8_970_219, NOK: 8_703_220 },
  "2020-01-02": {
    USD: 89_015_489,
    JPY: 912_825,
    GBP: 117_605_551,
    SEK: 9_582_215,
    NOK: 10_136_847,
  },
} satisfies Record<string, Record<OracleCurrency, number>>;

const isHistDate = (value: string): value is keyof typeof HIST_EXPECTED_RATE_EUR =>
  value in HIST_EXPECTED_RATE_EUR;

const expectedHistRate = (date: string, currency: string): number => {
  if (!isHistDate(date) || !isOracleCurrency(currency)) {
    throw new Error(`no oracle rate recorded for ${date}/${currency}`);
  }
  return HIST_EXPECTED_RATE_EUR[date][currency];
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

// --- parseEcbSdmxCsv --------------------------------------------------------

test("inverts the ECB rate (foreign-per-EUR) to EUR-per-foreign, scaled 1e8", async () => {
  const parsed = parseEcbSdmxCsv(await fixtureText(), new Set(["USD"]));
  expect(parsed).toEqual([{ date: "2026-08-27", currency: USD, rateEur: EXPECTED_RATE_EUR.USD }]);
});

test("returns exactly the wanted currencies, ignoring every other row", async () => {
  const parsed = parseEcbSdmxCsv(await fixtureText(), new Set(["SEK"]));
  expect(parsed).toEqual([{ date: "2026-08-27", currency: SEK, rateEur: EXPECTED_RATE_EUR.SEK }]);
});

test("returns every wanted currency present, each inverted correctly", async () => {
  const parsed = parseEcbSdmxCsv(await fixtureText(), new Set(["USD", "JPY", "GBP", "SEK", "NOK"]));
  expect(parsed).toHaveLength(5);
  for (const row of parsed) {
    expect(row.rateEur).toBe(expectedRate(row.currency));
  }
});

test("parses every day of a multi-day response", async () => {
  const parsed = parseEcbSdmxCsv(await histFixtureText(), new Set(["SEK"]));
  expect(parsed.map((row) => row.date)).toEqual([
    "2026-08-27",
    "2026-08-26",
    "2026-08-25",
    "2026-08-24",
    "2020-01-02",
  ]);
  for (const row of parsed) {
    expect(row.rateEur).toBe(expectedHistRate(row.date, row.currency));
  }
});

test("never returns EUR, even if a caller's wanted set asks for it", () => {
  const text =
    "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE\n" +
    "EXR.D.EUR.EUR.SP00.A,D,EUR,EUR,SP00,A,2026-08-27,1.0000\n";
  expect(parseEcbSdmxCsv(text, new Set(["EUR"]))).toEqual([]);
});

test("skips a day ECB did not publish rather than discarding the days it did", () => {
  const text =
    "KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE\n" +
    "EXR.D.SEK.EUR.SP00.A,D,SEK,EUR,SP00,A,2026-08-26,\n" +
    "EXR.D.SEK.EUR.SP00.A,D,SEK,EUR,SP00,A,2026-08-27,11.2340\n";
  expect(parseEcbSdmxCsv(text, new Set(["SEK"]))).toEqual([
    { date: "2026-08-27", currency: SEK, rateEur: EXPECTED_RATE_EUR.SEK },
  ]);
});

test("rejects a response whose header is not the SDMX layout", () => {
  expect(() => parseEcbSdmxCsv("Date,SEK\n2026-08-27,11.2340\n", new Set(["SEK"]))).toThrow(
    /puuttuu odotettu sarake/,
  );
});

test("rejects an empty response instead of reporting no rates", () => {
  expect(() => parseEcbSdmxCsv("", new Set(["SEK"]))).toThrow(/tyhjä/);
});

test("reads columns by name, so a response with extra columns still parses", () => {
  const text =
    "TITLE,CURRENCY,TIME_PERIOD,OBS_VALUE,UNIT\n" + "Swedish krona,SEK,2026-08-27,11.2340,SEK\n";
  expect(parseEcbSdmxCsv(text, new Set(["SEK"]))).toEqual([
    { date: "2026-08-27", currency: SEK, rateEur: EXPECTED_RATE_EUR.SEK },
  ]);
});

test("the request asks for exactly the wanted currencies, from the given date", () => {
  const url = ecbSeriesUrl(["SEK", "NOK"], "2020-01-02");
  expect(url).toStartWith(ECB_DATA_URL);
  expect(url).toContain("D.NOK+SEK.EUR.SP00.A");
  expect(url).toContain("startPeriod=2020-01-02");
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
    expect(String(url)).toStartWith(ECB_DATA_URL);
    return new Response(await fixtureText());
  };
  const result = await refreshFxRates(db, { fetchImpl: stub });
  expect(result).toEqual({ inserted: 1 });
  const rows = db.select().from(fxRates).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ currency: SEK, rateEur: EXPECTED_RATE_EUR.SEK });
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
  expect(rows[0]).toMatchObject({ currency: SEK, rateEur: EXPECTED_RATE_EUR.SEK });
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

test("ensureFxRate returns null (not a thrown error) when ECB has nothing older than the requested date", async () => {
  const { db } = testDb();
  const dispatch: FetchImpl = async () => new Response(await histFixtureText());
  const rate = await ensureFxRate(db, SEK, "2020-01-01", dispatch);
  expect(rate).toBeNull();
  // Everything the request did return is still stored, so a later lookup on or after
  // any of those dates is served without another fetch.
  expect(db.select().from(fxRates).all()).toHaveLength(5);
});

test("ensureFxRate resolves a back-dated request in one ranged fetch -- the previously-blocked case", async () => {
  const { db } = testDb();
  const dispatch: FetchImpl = async () => new Response(await histFixtureText());
  const rate = await ensureFxRate(db, SEK, "2020-01-02", dispatch);
  expect(rate).toBe(expectedHistRate("2020-01-02", "SEK"));
  const rows = db.select().from(fxRates).all();
  expect(rows.some((r) => r.date === "2020-01-02" && r.currency === "SEK")).toBe(true);
});

test("ensureFxRate asks ECB once, for the requested currency and from the requested date", async () => {
  const { db } = testDb();
  const urls: string[] = [];
  const dispatch: FetchImpl = async (input) => {
    urls.push(String(input));
    return new Response(await histFixtureText());
  };
  await ensureFxRate(db, SEK, "2020-01-02", dispatch);
  expect(urls).toHaveLength(1);
  expect(urls[0]).toContain("D.SEK.EUR.SP00.A");
  expect(urls[0]).toContain("startPeriod=2020-01-02");
});

test("ensureFxRate swallows a fetch failure to null instead of throwing out of a commit", async () => {
  const { db } = testDb();
  const failing = async (): Promise<Response> =>
    new Response("down", { status: 503, statusText: "Service Unavailable" });
  const rate = await ensureFxRate(db, SEK, "2026-08-27", failing);
  expect(rate).toBeNull();
  expect(db.select().from(fxRates).all()).toEqual([]);
});

// --- backfillFxRates -- the historical-file catch-up sweep (nightly + on import commit) ---

test("backfills nothing and touches no network for an empty ledger", async () => {
  const { db } = testDb();
  const mustNotBeCalled: FetchImpl = () => {
    throw new Error("must not be called");
  };
  const result = await backfillFxRates(db, { fetchImpl: mustNotBeCalled });
  expect(result).toEqual({ inserted: 0, currencies: 0 });
});

test("backfills nothing when the ledger only ever traded EUR", async () => {
  const { db } = testDb();
  seedTransaction(db, EUR);
  const mustNotBeCalled: FetchImpl = () => {
    throw new Error("must not be called");
  };
  const result = await backfillFxRates(db, { fetchImpl: mustNotBeCalled });
  expect(result).toEqual({ inserted: 0, currencies: 0 });
});

test("asks from the ledger's own earliest needed date, not from a recent window", async () => {
  const { db } = testDb();
  seedTransaction(db, SEK); // tradeDate 2026-01-01, see seedTransaction's own doc
  const dispatch: FetchImpl = async (input) => {
    expect(String(input)).toStartWith(ECB_DATA_URL);
    expect(String(input)).toContain("startPeriod=2026-01-01");
    return new Response(await histFixtureText());
  };
  const result = await backfillFxRates(db, { fetchImpl: dispatch });
  expect(result.currencies).toBe(1);
  expect(result.inserted).toBeGreaterThan(0);
});

test("backfills a currency held only by an instrument's own quotation currency, back to that instrument's earliest transaction", async () => {
  // Mirrors refreshFxRates' own C1 case, but for the historical catch-up: a fund whose
  // transactions are booked in EUR (§10a A2/A5) but whose price/NAV is quoted in SEK.
  const { db } = testDb();
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
  const fund = db
    .insert(instruments)
    .values({
      isin: "SE0009123456",
      ticker: null,
      name: "Testirahasto Ruotsi",
      kind: "fund",
      currency: SEK,
      priceSource: "manual",
      sourceKey: "testirahasto-sverige",
    })
    .returning()
    .get();
  db.insert(transactions)
    .values({
      accountId: account.id,
      instrumentId: fund.id,
      type: "BUY",
      tradeDate: "2026-08-24", // matches a real fixture row
      currency: EUR, // the cash that moved was EUR -- see fx.ts's C1 comment
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
    })
    .run();

  const dispatch: FetchImpl = async () => new Response(await histFixtureText());
  const result = await backfillFxRates(db, { fetchImpl: dispatch });
  expect(result).toEqual({ inserted: 5, currencies: 1 });
  const rows = db.select().from(fxRates).where(eq(fxRates.currency, SEK)).all();
  expect(rows).toHaveLength(5);
  // Reaches all the way back to the fixture's own oldest row, well before the
  // transaction's own 2026-08-24 date -- exactly what "not just today" means.
  expect(rows.some((r) => r.date === "2020-01-02")).toBe(true);

  // Idempotent: a second run finds SEK's history already reaches its earliest need and
  // never touches the network again -- this is what keeps a nightly call cheap forever
  // after the first real backfill, not a re-download of the whole file every night.
  const mustNotBeCalled: FetchImpl = () => {
    throw new Error("must not be called");
  };
  const second = await backfillFxRates(db, { fetchImpl: mustNotBeCalled });
  expect(second).toEqual({ inserted: 0, currencies: 0 });
});

test("aggregates a mixed batch: one currency already covered is skipped, another still needing backfill is fetched -- one combined request either way", async () => {
  const { db } = testDb();
  // SEK already has a row reaching back before its own earliest need -- no backfill due.
  seedTransaction(db, SEK); // tradeDate 2026-01-01
  db.insert(fxRates).values({ date: "2025-01-01", currency: SEK, rateEur: 9_000_000 }).run();
  // USD needs a fresh fetch: no fx_rates row for it at all yet.
  seedTransaction(db, USD); // tradeDate 2026-01-01

  let calls = 0;
  const dispatch: FetchImpl = async () => {
    calls++;
    return new Response(await histFixtureText());
  };
  const result = await backfillFxRates(db, { fetchImpl: dispatch });
  expect(calls).toBe(1); // one combined fetch, not one per currency
  expect(result.currencies).toBe(1); // only USD was pending

  // SEK's pre-existing row is untouched -- still exactly the one row it started with.
  const sekRows = db.select().from(fxRates).where(eq(fxRates.currency, SEK)).all();
  expect(sekRows).toEqual([{ date: "2025-01-01", currency: SEK, rateEur: 9_000_000 }]);
  // USD is now backfilled from the historical fixture.
  const usdRows = db.select().from(fxRates).where(eq(fxRates.currency, USD)).all();
  expect(usdRows.length).toBeGreaterThan(0);
});

test("surfaces a non-OK historical ECB response as a thrown error instead of silently backfilling nothing", async () => {
  const { db } = testDb();
  seedTransaction(db, SEK);
  const failing: FetchImpl = async () =>
    new Response("down", { status: 503, statusText: "Service Unavailable" });
  await expect(backfillFxRates(db, { fetchImpl: failing })).rejects.toThrow(/503/);
});
