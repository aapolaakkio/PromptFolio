import { and, asc, desc, eq, lte } from "drizzle-orm";

import { EUR, type Currency } from "../core/money.ts";
import type { getDb } from "./db/index.ts";
import { fxRates, instruments, transactions } from "./db/schema.ts";
import { fetchEcbRates, type EcbRow } from "./fx-ecb.ts";
import type { FetchImpl } from "./prices/types.ts";

type Db = ReturnType<typeof getDb>["db"];

/**
 * How far back the nightly refresh asks for. Long enough to cover a run missed over a long
 * weekend or a short outage, short enough that the routine case stays a small response;
 * anything older is backfillFxRates' job.
 */
const REFRESH_WINDOW_DAYS = 10;

/** An ISO date `days` before today, for bounding a request rather than for any stored value. */
const isoDaysAgo = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

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

  // A short trailing window rather than the whole history: this runs nightly and only
  // needs whatever ECB published since the last run. backfillFxRates owns reaching back
  // to the ledger's own earliest date.
  const rows = await fetchEcbRates(fetchImpl, wanted, isoDaysAgo(REFRESH_WINDOW_DAYS));
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

  const rows = await fetchEcbRates(fetchImpl, wanted, since);
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
    // One ranged request covers both cases the old daily/historical two-step handled: a
    // recent trade and a back-dated one differ only in how far back `date` reaches.
    const rows = await fetchEcbRates(fetchImpl, new Set([currency]), date);
    insertFxRates(db, rows);
    return fxRateOn(db, currency, date);
  } catch {
    return null;
  }
};
