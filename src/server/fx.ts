import { and, asc, desc, eq, lte } from "drizzle-orm";
import { z } from "zod";

import { EUR, parseCurrency, parseFxRate, type Currency } from "../core/money";
import type { getDb } from "./db";
import { fxRates, instruments, transactions } from "./db/schema";
import type { FetchImpl } from "./prices/types";

type Db = ReturnType<typeof getDb>["db"];

export const ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref.csv";

/**
 * ECB's full daily-history file -- same currency columns as `eurofxref.csv`, one row per
 * TARGET business day back to 1999-01-04, newest first. Verified by a real fetch
 * (2026-08-28): `Content-Type: text/csv`, a `Date,USD,JPY,...` header identical in shape to
 * the daily file's, and one crucial difference the daily file's own format does not have --
 * each row's date is already ISO `YYYY-MM-DD` (e.g. `2010-02-14`), not the daily file's
 * spelled-out `D Month YYYY` (e.g. `27 August 2026`). `parseEcbHistDate` below exists
 * because of that one verified difference; everything else (comma-separated cells, `N/A`
 * for a currency ECB did not yet publish or has stopped publishing, values scaled and
 * inverted exactly like the daily file's) reuses `parseEcbValueRow`, the same per-row logic
 * `parseEcbCsv` itself calls.
 */
export const ECB_HIST_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.csv";

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

type EcbRow = { readonly date: string; readonly currency: Currency; readonly rateEur: number };

/**
 * Extracts every `wanted` currency's rate from one already-date-resolved ECB CSV line,
 * shared by `parseEcbCsv` (the daily file's single value line) and `parseEcbHistCsv` (each
 * of the historical file's many value lines) -- the two files' rows have the exact same
 * shape (a header of currency codes, a value per column), only their date column's text
 * format and the number of value lines differ.
 *
 * Throws if `values` has a different number of cells than `headers`: a genuinely truncated
 * download (the connection dropped mid-row) silently drops trailing columns rather than
 * raising an HTTP error, and without this check that would read as "this row just happens
 * to have no rate for its last few currencies" -- indistinguishable from a legitimate `N/A`
 * -- producing partial rates that look complete. A short row is exactly the shape a cut-off
 * response leaves behind, so it fails loudly here instead.
 *
 * EUR itself is excluded even if a caller's `wanted` set somehow contains it: the file has
 * no EUR column (EUR is its implicit base), and an EUR/EUR rate would be meaningless --
 * `fx_rates` must never carry one (see that table's schema comment).
 *
 * A single unparseable currency column (a non-numeric cell, e.g. an ECB "N/A" for a
 * currency ECB has stopped publishing) is skipped rather than failing the whole row: the
 * other columns' rates are still good data and one bad cell should not block them,
 * mirroring this project's "one failing source must not stop the others" rule at column
 * granularity.
 */
const parseEcbValueRow = (
  headers: readonly string[],
  values: readonly string[],
  wanted: ReadonlySet<string>,
  date: string,
): EcbRow[] => {
  if (values.length !== headers.length) {
    throw new Error(
      `ECB-tiedoston rivi on rikki (${date}): odotettiin ${headers.length} saraketta, saatiin ${values.length}`,
    );
  }
  const out: EcbRow[] = [];
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

  return parseEcbValueRow(headers, values, wanted, date);
};

const ECB_HIST_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const EcbHistDateParts = z.object({
  year: z.string().regex(/^\d{4}$/),
  month: z.string().regex(/^(0[1-9]|1[0-2])$/),
  day: z.string().regex(/^([0-2]\d|3[01])$/),
});

/**
 * The historical file's date column, verified by a real fetch to already be ISO
 * `YYYY-MM-DD` (unlike the daily file's spelled-out `D Month YYYY`, see `ECB_HIST_URL`'s own
 * comment) -- so unlike `parseEcbDate`, this never resolves a month name, but it is
 * zod-validated the same way and just as strictly (a real calendar day-of-month range, a
 * real month range) rather than trusted as-is, for the same reason `parseEcbDate` does not
 * lean on JS `Date`'s free-text parser: this is every historical `fx_rates` row's primary
 * key.
 */
const parseEcbHistDate = (text: string): string => {
  const trimmed = text.trim();
  const match = ECB_HIST_DATE_PATTERN.exec(trimmed);
  const parsed = match
    ? EcbHistDateParts.safeParse({ year: match[1], month: match[2], day: match[3] })
    : undefined;
  if (!match || !parsed?.success) {
    throw new Error(`ECB-historiatiedoston päivämäärä ei kelpaa: ${JSON.stringify(text)}`);
  }
  return trimmed;
};

/**
 * Parses the ECB `eurofxref-hist.csv` historical file: one header row of currency codes,
 * then one value row per TARGET business day, newest first (verified by a real fetch --
 * see `ECB_HIST_URL`'s comment). Reuses `parseEcbValueRow` for each line, exactly like
 * `parseEcbCsv` does for the daily file's one line.
 *
 * `opts.since`, when given, bounds how much of a multi-thousand-row file is actually kept:
 * since the file is newest-first, this stops as soon as it has pushed one row dated before
 * `since` -- that one extra row is deliberate, not an off-by-one, so a caller doing a
 * backfill "from `since` onward" still gets the last known rate for any date between
 * `since` and that row's own date, exactly matching `fxRateOn`'s own "newest row on or
 * before" semantics. Without `opts.since`, every row is parsed and returned.
 */
export const parseEcbHistCsv = (
  text: string,
  wanted: ReadonlySet<string>,
  opts: { since?: string } = {},
): EcbRow[] => {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  const headerLine = lines[0];
  if (headerLine === undefined || !/^Date\b/i.test(headerLine.trim())) {
    throw new Error("ECB-historiatiedoston muoto ei kelpaa: otsikkorivi puuttuu");
  }
  const headers = headerLine.split(",").map((cell) => cell.trim());
  const since = opts.since;

  const out: EcbRow[] = [];
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (line === undefined) continue;
    const values = line.split(",").map((cell) => cell.trim());
    const dateText = values[0];
    if (dateText === undefined) {
      throw new Error(`ECB-historiatiedoston rivi ${lineIndex + 1}: päivämääräsarake puuttuu`);
    }
    const date = parseEcbHistDate(dateText);

    out.push(...parseEcbValueRow(headers, values, wanted, date));
    if (since !== undefined && date < since) break;
  }
  return out;
};

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
 * Fetches and parses the ECB historical file for exactly `wanted`'s currencies, from
 * `since` onward (see `parseEcbHistCsv`'s own doc for the exact boundary). No DB access.
 */
const fetchEcbHistRows = async (
  fetchImpl: FetchImpl,
  wanted: ReadonlySet<string>,
  since: string,
): Promise<EcbRow[]> => {
  const response = await fetchImpl(ECB_HIST_URL);
  if (!response.ok) {
    throw new Error(`ECB (historia) vastasi ${response.status} ${response.statusText}`);
  }
  return parseEcbHistCsv(await response.text(), wanted, { since });
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

/** Sets `map[currency]` to `date` if it is earlier than what is already stored (or nothing is). */
const bumpEarliest = (map: Map<Currency, string>, currency: Currency, date: string): void => {
  const existing = map.get(currency);
  if (existing === undefined || date < existing) map.set(currency, date);
};

/**
 * For every non-EUR currency the ledger needs a rate for -- the same union `refreshFxRates`
 * above already uses (a transaction's own `currency`, or an instrument's quotation
 * `currency`) -- the earliest trade date it must be convertible on.
 *
 * This is `core/returns.ts`'s `valueSeries` requirement made explicit: it looks up
 * `fxOn(instrument.currency, date)` for every date a position is held, starting at that
 * position's first transaction, so a currency's "earliest needed" date is the earliest
 * trade date of any transaction that either was itself booked in that currency, or that put
 * a non-EUR-quoted instrument into the ledger. A currency that only ever appears on an
 * instrument with zero transactions (never actually held) needs no backfill at all -- there
 * is no date range to value it over yet -- so it is correctly absent from the result.
 */
const earliestNeededDateByCurrency = (db: Db): Map<Currency, string> => {
  const byCurrency = new Map<Currency, string>();

  for (const row of db
    .select({ currency: transactions.currency, tradeDate: transactions.tradeDate })
    .from(transactions)
    .all()) {
    if (row.currency === EUR) continue;
    bumpEarliest(byCurrency, row.currency, row.tradeDate);
  }

  for (const row of db
    .select({ currency: instruments.currency, tradeDate: transactions.tradeDate })
    .from(transactions)
    .innerJoin(instruments, eq(transactions.instrumentId, instruments.id))
    .all()) {
    if (row.currency === EUR) continue;
    bumpEarliest(byCurrency, row.currency, row.tradeDate);
  }

  return byCurrency;
};

/**
 * True when `currency`'s stored history does not yet reach `earliestNeeded` -- either no
 * `fx_rates` row exists for it at all, or its earliest one is dated after that. Mirrors
 * `prices/refresh.ts`'s own `needsBackfill`: this is what keeps `backfillFxRates` cheap on
 * every ordinary night after the first real backfill completes, exactly the way that
 * function's own doc comment describes for prices.
 */
const needsFxBackfill = (db: Db, currency: Currency, earliestNeeded: string): boolean => {
  const earliestRow = db
    .select({ date: fxRates.date })
    .from(fxRates)
    .where(eq(fxRates.currency, currency))
    .orderBy(asc(fxRates.date))
    .limit(1)
    .get();
  return earliestRow === undefined || earliestRow.date > earliestNeeded;
};

/** The oldest date in `dates`, or `null` if `dates` is empty. */
const earliestOf = (dates: readonly string[]): string | null =>
  dates.reduce<string | null>((min, date) => (min === null || date < min ? date : min), null);

export type BackfillFxResult = { readonly inserted: number; readonly currencies: number };

/**
 * The historical-file counterpart to `refreshFxRates`'s daily fetch: catches every held
 * currency's `fx_rates` history up to the earliest date the ledger actually needs it (§4.2 /
 * §10a A1's "no rate at all before the first refresh" gap, confirmed real for SE0002756973 --
 * see this file's `ECB_HIST_URL` comment for the source that closes it).
 *
 * One combined fetch, not one per currency: ECB serves every currency's history in a single
 * response regardless of how many columns a caller actually wants, so every currency still
 * needing backfill (`needsFxBackfill`) is unioned into one `wanted` set and one `since` --
 * the oldest of their individual earliest-needed dates -- before the historical file is
 * fetched even once. A currency whose earliest-needed date is later than that shared `since`
 * simply receives a few extra, harmless rows it didn't strictly need (deduplicated by
 * `insertFxRates`' `onConflictDoNothing` like everything else here).
 *
 * Idempotent by construction, not just by the insert's own conflict handling: once a
 * currency's earliest stored row reaches its earliest-needed date, `needsFxBackfill` excludes
 * it from every later call, so a currency fully backfilled once is never re-fetched -- this
 * is the mechanism that keeps a nightly call to this function from re-downloading the whole
 * history every night, mirroring `prices/refresh.ts`'s `backfillMany`/`needsBackfill` pair for
 * price history.
 *
 * Nothing needing backfill (an empty ledger, or one whose every held currency's history
 * already reaches back far enough) means this returns without calling `fetchImpl` at all.
 */
export const backfillFxRates = async (
  db: Db,
  opts: { fetchImpl?: FetchImpl } = {},
): Promise<BackfillFxResult> => {
  const fetchImpl = opts.fetchImpl ?? fetch;

  const pending = [...earliestNeededDateByCurrency(db)].filter(([currency, earliestNeeded]) =>
    needsFxBackfill(db, currency, earliestNeeded),
  );
  if (pending.length === 0) return { inserted: 0, currencies: 0 };

  const wanted = new Set<string>(pending.map(([currency]) => currency));
  const since = earliestOf(pending.map(([, earliestNeeded]) => earliestNeeded));
  // SAFETY: `pending` is non-empty (checked above), so `earliestOf` always has at least one
  // date to compare and cannot return `null`.
  if (since === null) return { inserted: 0, currencies: 0 };

  const rows = await fetchEcbHistRows(fetchImpl, wanted, since);
  const inserted = insertFxRates(db, rows);
  return { inserted, currencies: pending.length };
};

/**
 * Resolves an fx rate for `currency` on or before `date`, fetching ECB's rates on demand if
 * `fx_rates` has nothing yet that satisfies it (C1b: breaks the "first non-EUR transaction"
 * deadlock; extended below to also break the "first *back-dated* non-EUR transaction"
 * deadlock).
 *
 * The deadlock this exists to break, verified directly: `refreshFxRates`/`backfillFxRates`
 * above only ever fetch currencies the ledger *already* holds -- but a currency's very first
 * transaction is exactly the row that would introduce it to the ledger, and
 * `import/commit.ts` rejected committing that row for having no `fx_rates` entry yet.
 * Neither side could move first.
 *
 * Tries the daily file first, cheaply satisfying the common case (an import of a recent
 * trade): `eurofxref.csv` publishes only the latest TARGET business day's rate, so this
 * alone can only satisfy a `date` on or before that day. When it can't -- a genuinely
 * back-dated transaction in a currency never held before, confirmed a real, committable-today
 * case rather than a hypothetical one -- this falls back to `eurofxref-hist.csv`, fetching
 * and storing that currency's history back through `date` (see `parseEcbHistCsv`'s `since`
 * semantics for the exact boundary) before trying the lookup again. A date older than the
 * historical file's own earliest row (1999-01-04) still returns `null`, exactly as before.
 *
 * A fetch failure at either step (ECB unreachable, non-200, a malformed file) is swallowed to
 * `null` rather than thrown: an external-source outage during an import must degrade to "rate
 * still unresolved" (the caller's existing, informative refusal), never surface a raw network
 * error out of a commit (§9.1's External-error handling). Whatever either fetch already
 * managed to store before the failure is kept -- only the return value degrades.
 */
export const ensureFxRate = async (
  db: Db,
  currency: Currency,
  date: string,
  fetchImpl: FetchImpl,
): Promise<number | null> => {
  const existing = fxRateOn(db, currency, date);
  if (existing !== null) return existing;

  try {
    const dailyRows = await fetchEcbRows(fetchImpl, new Set([currency]));
    insertFxRates(db, dailyRows);
    const afterDaily = fxRateOn(db, currency, date);
    if (afterDaily !== null) return afterDaily;

    const histRows = await fetchEcbHistRows(fetchImpl, new Set([currency]), date);
    insertFxRates(db, histRows);
    return fxRateOn(db, currency, date);
  } catch {
    return null;
  }
};
