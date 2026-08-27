import { z } from "zod";

import { EUR, parseCurrency, parseFxRate, type Currency } from "../core/money";
import type { getDb } from "./db";
import { fxRates, transactions } from "./db/schema";
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

/**
 * Fetches the ECB daily reference rates and stores every non-EUR currency
 * the ledger actually holds, idempotently (a re-run for the same date
 * inserts nothing new -- `fx_rates`' primary key is `(date, currency)`).
 *
 * §10a A1 supersedes the original brief here: the real portfolio holds
 * EUR and SEK, never USD, so this fetches *exactly* the ledger's own
 * non-EUR currencies via `transactions.currency` and never falls back to
 * a guessed default. An empty ledger -- nothing imported yet, or a ledger
 * that only ever traded in EUR -- means there is nothing to convert, so
 * this returns without calling `fetchImpl` at all: no network call, no
 * USD placeholder row.
 */
export const refreshFxRates = async (
  db: Db,
  opts: { fetchImpl?: FetchImpl } = {},
): Promise<{ inserted: number }> => {
  const fetchImpl = opts.fetchImpl ?? fetch;

  const held = db
    .selectDistinct({ currency: transactions.currency })
    .from(transactions)
    .all()
    .map((row) => row.currency)
    .filter((currency) => currency !== EUR);

  if (held.length === 0) return { inserted: 0 };
  const wanted = new Set<string>(held);

  const response = await fetchImpl(ECB_URL);
  if (!response.ok) {
    throw new Error(`ECB vastasi ${response.status} ${response.statusText}`);
  }
  const rows = parseEcbCsv(await response.text(), wanted);

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
  return { inserted };
};
