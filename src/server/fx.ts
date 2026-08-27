import { and, desc, eq, lte } from "drizzle-orm";
import { z } from "zod";

import { EUR, parseCurrency, parseFxRate, type Currency } from "../core/money";
import type { getDb } from "./db";
import { fxRates, instruments, transactions } from "./db/schema";
import type { FetchImpl } from "./prices/types";

type Db = ReturnType<typeof getDb>["db"];

export const ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref.csv";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const ECB_DATE_PATTERN = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/;
/** Matches ECB's plain decimal rate cells ("1.0870"). Never negative -- ECB never publishes one. */
const ECB_RATE_PATTERN = /^\d+(\.\d+)?$/;

const EcbDateParts = z.object({
  day: z.string().regex(/^([1-9]|[12]\d|3[01])$/),
  month: z.enum(MONTH_NAMES),
  year: z.string().regex(/^\d{4}$/),
});

/**
 * ECB's date column is always "D Month YYYY" in English (e.g. "27 August
 * 2026") -- but rather than lean on JS `Date`'s locale-and-engine-dependent
 * free-text parser for something this load-bearing (every fx_rates row's
 * primary key), the month name is resolved against an explicit table and
 * the whole shape validated by zod before anything is trusted.
 */
const parseEcbDate = (text: string): string => {
  const match = ECB_DATE_PATTERN.exec(text.trim());
  const parsed = match
    ? EcbDateParts.safeParse({ day: match[1], month: match[2], year: match[3] })
    : undefined;
  if (!match || !parsed?.success) {
    throw new Error(`ECB-tiedoston päivämäärä ei kelpaa: ${JSON.stringify(text)}`);
  }
  const monthNumber = MONTH_NAMES.indexOf(parsed.data.month) + 1;
  return `${parsed.data.year}-${String(monthNumber).padStart(2, "0")}-${parsed.data.day.padStart(2, "0")}`;
};

/**
 * Inverts a rate already scaled by 1e8 (foreign-per-EUR, `parseFxRate`'s
 * own representation of the raw ECB cell) into EUR-per-foreign, also
 * scaled by 1e8 -- exact bigint arithmetic (`(1e8)^2 / scaled`, half-up
 * rounded on the remainder) rather than a float division, so this is
 * exactly as precise as `core/money.ts`'s own scale contract and uses the
 * same rounding rule `parseScaled` already applies elsewhere in this
 * project. Verified against the brief's own worked example: 1 EUR =
 * 1.0870 USD inverts to 91_996_320 (0.91996320... EUR per USD).
 */
const invertScaledRate = (scaled: bigint): number => {
  const numerator = 10n ** 16n;
  const quotient = numerator / scaled;
  const remainder = numerator % scaled;
  return Number(remainder * 2n >= scaled ? quotient + 1n : quotient);
};

/**
 * Parses the ECB `eurofxref.csv` daily file (two lines: a header row of
 * currency codes, one value row) into EUR-per-foreign-unit rates, scaled
 * 1e8 -- the direction `core/money.ts`'s `toEur` multiplies by. ECB
 * publishes the opposite direction (1 EUR = N foreign units), so every
 * value is inverted.
 *
 * Only currencies present in `wanted` are returned: §10a A1 -- the real
 * portfolio holds EUR and SEK, no USD -- so this never assumes which
 * foreign currencies matter and never defaults to a guessed set; the
 * caller (`refreshFxRates`) passes exactly the currencies its own ledger
 * holds.
 *
 * EUR itself is excluded even if a caller's `wanted` set somehow contains
 * it: the file has no EUR column (EUR is its implicit base), and an
 * EUR/EUR rate would be meaningless -- `fx_rates` must never carry one
 * (see that table's schema comment).
 *
 * A single unparseable currency column (a non-numeric cell, e.g. an ECB
 * "N/A" for a currency ECB has stopped publishing) is skipped rather than
 * failing the whole file: the other columns' rates are still good data
 * and one bad cell should not block them, mirroring this project's
 * "one failing source must not stop the others" rule at column
 * granularity.
 */
export const parseEcbCsv = (
  text: string,
  wanted: ReadonlySet<string>,
): Array<{ date: string; currency: Currency; rateEur: number }> => {
  const [headerLine, valueLine] = text.split(/\r?\n/);
  if (headerLine === undefined || valueLine === undefined || !/^Date\b/i.test(headerLine.trim())) {
    throw new Error("ECB-tiedoston muoto ei kelpaa: otsikkorivi puuttuu");
  }
  const headers = headerLine.split(",").map((cell) => cell.trim());
  const values = valueLine.split(",").map((cell) => cell.trim());

  const dateText = values[0];
  if (dateText === undefined) {
    throw new Error("ECB-tiedoston muoto ei kelpaa: päivämääräsarake puuttuu");
  }
  const date = parseEcbDate(dateText);

  const out: Array<{ date: string; currency: Currency; rateEur: number }> = [];
  for (let i = 1; i < headers.length; i++) {
    const rawCurrency = headers[i];
    if (rawCurrency === undefined || rawCurrency === "EUR" || !wanted.has(rawCurrency)) continue;
    const rawValue = values[i];
    if (rawValue === undefined || !ECB_RATE_PATTERN.test(rawValue)) continue;

    const currency = parseCurrency(rawCurrency);
    const { scaled } = parseFxRate(rawValue, currency);
    if (scaled <= 0n) continue;

    out.push({ date, currency, rateEur: invertScaledRate(scaled) });
  }
  return out;
};

type EcbRow = { readonly date: string; readonly currency: Currency; readonly rateEur: number };

/** Fetches and parses one ECB daily file for exactly `wanted`'s currencies. No DB access. */
const fetchEcbRows = async (
  fetchImpl: FetchImpl,
  wanted: ReadonlySet<string>,
): Promise<EcbRow[]> => {
  const response = await fetchImpl(ECB_URL);
  if (!response.ok) {
    throw new Error(`ECB vastasi ${response.status} ${response.statusText}`);
  }
  return parseEcbCsv(await response.text(), wanted);
};

/**
 * Inserts every row, idempotently (`fx_rates`' primary key is `(date, currency)`, so a
 * re-run for the same date/currency inserts nothing new). Returns the count actually
 * inserted. Shared by `refreshFxRates` (the scheduled job) and `ensureFxRate` (the
 * on-demand path C1b needs) so both write through the exact same defense-in-depth EUR
 * guard and conflict handling.
 */
const insertFxRates = (db: Db, rows: readonly EcbRow[]): number => {
  let inserted = 0;
  db.transaction((tx) => {
    for (const row of rows) {
      // Defense in depth: parseEcbCsv already excludes EUR, but a
      // meaningless EUR/EUR row must never reach this table under any
      // circumstance -- checked again at the write boundary rather than
      // trusted transitively from the parser.
      if (row.currency === EUR) continue;
      const result = tx
        .insert(fxRates)
        .values({ date: row.date, currency: row.currency, rateEur: row.rateEur })
        .onConflictDoNothing()
        .run();
      if (result.changes > 0) inserted++;
    }
  });
  return inserted;
};

/**
 * The newest `fx_rates` row for `currency` dated on or before `date`, or `null` if none
 * exists yet. Exported so `import/commit.ts` shares this exact lookup (previously its own
 * private copy) rather than a second implementation that could drift. Takes only the
 * `select` method it needs -- both the shared `Db` handle and a transaction's `tx` handle
 * satisfy this structurally, so a caller inside `db.transaction()` can pass `tx` straight
 * through.
 */
export const fxRateOn = (
  db: Pick<Db, "select">,
  currency: Currency,
  date: string,
): number | null => {
  const row = db
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.currency, currency), lte(fxRates.date, date)))
    .orderBy(desc(fxRates.date))
    .limit(1)
    .get();
  return row?.rateEur ?? null;
};

/**
 * Fetches the ECB daily reference rates and stores every non-EUR currency the ledger
 * actually holds, idempotently.
 *
 * §10a A1 supersedes the original brief here: the real portfolio holds EUR and SEK, never
 * USD, so this fetches *exactly* the currencies the ledger holds and never falls back to a
 * guessed default.
 *
 * C1 fix (2026-08-27): the "currencies the ledger holds" set used to come from
 * `transactions.currency` alone. Verified against a real migrated database: per §10a A2/A5
 * a fund like the user's SEK holding is booked in EUR (the transaction's own `currency` is
 * EUR -- that is what actually changed hands) while its price/NAV is quoted in SEK. SEK
 * therefore never appeared in `transactions.currency`, so its rate was never fetched, and
 * `valuation.ts`'s `holdingsFor` silently fell back to a fabricated `0,00 €` market value
 * with no stale badge (the price row itself was dated today -- only the FX rate was
 * missing). Now sourced from `instruments.currency` too (the instrument's own quotation
 * currency), unioned with `transactions.currency`, so a EUR-booked, SEK-quoted holding's
 * rate is fetched regardless of which side ever recorded "SEK".
 *
 * An empty ledger -- nothing imported yet, or a ledger that only ever traded EUR
 * instruments -- means there is nothing to convert, so this returns without calling
 * `fetchImpl` at all: no network call, no placeholder row.
 */
export const refreshFxRates = async (
  db: Db,
  opts: { fetchImpl?: FetchImpl } = {},
): Promise<{ inserted: number }> => {
  const fetchImpl = opts.fetchImpl ?? fetch;

  const txnCurrencies = db
    .selectDistinct({ currency: transactions.currency })
    .from(transactions)
    .all()
    .map((row) => row.currency);
  const instrumentCurrencies = db
    .selectDistinct({ currency: instruments.currency })
    .from(instruments)
    .all()
    .map((row) => row.currency);
  const held = [...new Set([...txnCurrencies, ...instrumentCurrencies])].filter(
    (currency) => currency !== EUR,
  );

  if (held.length === 0) return { inserted: 0 };
  const wanted = new Set<string>(held);

  const rows = await fetchEcbRows(fetchImpl, wanted);
  const inserted = insertFxRates(db, rows);
  return { inserted };
};

/**
 * Resolves an fx rate for `currency` on or before `date`, fetching ECB's current daily
 * rate on demand if `fx_rates` has nothing yet (C1b: breaks the "first non-EUR
 * transaction" deadlock). Returns the resolved rate, or `null` if it is still unresolved
 * after trying.
 *
 * The deadlock this exists to break, verified directly: `refreshFxRates` above only ever
 * fetches currencies the ledger *already* holds -- but a currency's very first transaction
 * is exactly the row that would introduce it to the ledger, and `import/commit.ts`
 * rejected committing that row for having no `fx_rates` entry yet. Neither side could move
 * first.
 *
 * `eurofxref.csv` (verified against §10a A5's fetch-things-for-real standard) publishes
 * only the latest TARGET business day's rate, not history -- there is no ECB endpoint
 * wired up here that takes a date. So this can only satisfy `date` when the fetched rate's
 * own date is on or before it: importing today's (or a recent) non-EUR trade works; a
 * genuinely back-dated one still returns `null`, exactly as it did before, and the caller
 * reports the same honest "no rate for this date" refusal either way. ECB does publish
 * `eurofxref-hist.csv` for history, but nothing observed so far needs it -- adding a second
 * ingestion path on spec (rather than against a real, confirmed need) is exactly the kind
 * of guess §10a's amendments exist to correct, so it is deliberately not added here.
 *
 * A fetch failure (ECB unreachable, non-200, a malformed file) is swallowed to `null`
 * rather than thrown: an external-source outage during an import must degrade to "rate
 * still unresolved" (the caller's existing, informative refusal), never surface a raw
 * network error out of a commit (§9.1's External-error handling).
 */
export const ensureFxRate = async (
  db: Db,
  currency: Currency,
  date: string,
  fetchImpl: FetchImpl,
): Promise<number | null> => {
  const existing = fxRateOn(db, currency, date);
  if (existing !== null) return existing;

  let rows: EcbRow[];
  try {
    rows = await fetchEcbRows(fetchImpl, new Set([currency]));
  } catch {
    return null;
  }
  insertFxRates(db, rows);
  return fxRateOn(db, currency, date);
};
