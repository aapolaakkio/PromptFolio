import { and, asc, desc, eq, lte } from "drizzle-orm";

import { EUR, type Currency } from "../core/money.ts";
import type { Db } from "./db/index.ts";
import { fxRates, instruments, transactions } from "./db/schema.ts";
import { fetchEcbRates, type EcbRow } from "./fx-ecb.ts";
import type { FetchImpl } from "./prices/types.ts";

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
const insertFxRates = async (db: Db, rows: readonly EcbRow[]): Promise<number> => {
  const statements = rows
    // Defense in depth: parseEcbCsv already excludes EUR, but a meaningless
    // EUR/EUR row must never reach this table under any circumstance --
    // checked again at the write boundary rather than trusted transitively
    // from the parser.
    .filter((row) => row.currency !== EUR)
    .map((row) =>
      db
        .insert(fxRates)
        .values({ date: row.date, currency: row.currency, rateEur: row.rateEur })
        .onConflictDoNothing()
        // How the insert reports whether it happened. D1 has no interactive
        // transaction, so a batched statement cannot be asked for its row
        // count afterwards -- an empty `returning` is the conflict.
        .returning({ date: fxRates.date }),
    );
  if (statements.length === 0) return 0;

  // One batch, which D1 runs as a single transaction: a failure rolls the
  // whole set back, the same guarantee the old `db.transaction` gave.
  //
  // SAFETY: `db.batch` is typed as a non-empty tuple to stop a caller passing
  // `[]`; `statements` is an array of the same element type, and the
  // `length === 0` return above is what establishes it is non-empty here.
  const results = await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
  return results.reduce((count, inserted) => count + inserted.length, 0);
};

/**
 * The newest rate for `currency` on or before `date`, or null. Takes only the
 * `select` method, so a caller inside a transaction can pass `tx` straight in.
 */
export const fxRateOn = async (
  db: Pick<Db, "select">,
  currency: Currency,
  date: string,
): Promise<number | null> => {
  const row = await db
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.currency, currency), lte(fxRates.date, date)))
    .orderBy(desc(fxRates.date))
    .limit(1)
    .get();
  return row?.rateEur ?? null;
};

/**
 * ECB's daily rates for every non-EUR currency the ledger holds, idempotently.
 *
 * "Holds" means both a transaction's own currency and an instrument's quotation
 * currency. A fund booked in EUR but quoted in SEK never puts SEK on a
 * transaction, so reading transactions alone never fetched its rate and the
 * holding fell back to a fabricated 0,00 EUR with no staleness badge.
 *
 * A ledger with nothing to convert makes no network call at all.
 */
export const refreshFxRates = async (
  db: Db,
  opts: { fetchImpl?: FetchImpl } = {},
): Promise<{ inserted: number }> => {
  const fetchImpl = opts.fetchImpl ?? fetch;

  const txnCurrencies = (
    await db.selectDistinct({ currency: transactions.currency }).from(transactions).all()
  ).map((row) => row.currency);
  const instrumentCurrencies = (
    await db.selectDistinct({ currency: instruments.currency }).from(instruments).all()
  ).map((row) => row.currency);
  const held = [...new Set([...txnCurrencies, ...instrumentCurrencies])].filter(
    (currency) => currency !== EUR,
  );

  if (held.length === 0) return { inserted: 0 };
  const wanted = new Set<string>(held);

  // A short trailing window rather than the whole history: this runs nightly and only
  // needs whatever ECB published since the last run. backfillFxRates owns reaching back
  // to the ledger's own earliest date.
  const rows = await fetchEcbRates(fetchImpl, wanted, isoDaysAgo(REFRESH_WINDOW_DAYS));
  const inserted = await insertFxRates(db, rows);
  return { inserted };
};

/** Sets `map[currency]` to `date` if it is earlier than what is already stored (or nothing is). */
const bumpEarliest = (map: Map<Currency, string>, currency: Currency, date: string): void => {
  const existing = map.get(currency);
  if (existing === undefined || date < existing) map.set(currency, date);
};

/**
 * The earliest date each held currency must be convertible on.
 *
 * `valueSeries` looks up a rate for every date a position is held, so that is the
 * position's first transaction. A currency appearing only on an instrument
 * nobody holds has no range to value and is absent.
 */
const earliestNeededDateByCurrency = async (db: Db): Promise<Map<Currency, string>> => {
  const byCurrency = new Map<Currency, string>();

  for (const row of await db
    .select({ currency: transactions.currency, tradeDate: transactions.tradeDate })
    .from(transactions)
    .all()) {
    if (row.currency === EUR) continue;
    bumpEarliest(byCurrency, row.currency, row.tradeDate);
  }

  for (const row of await db
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
const needsFxBackfill = async (
  db: Db,
  currency: Currency,
  earliestNeeded: string,
): Promise<boolean> => {
  const earliestRow = await db
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
 * Every held currency's history back to the earliest date the ledger needs.
 *
 * One combined fetch: ECB serves every currency in a single response whatever a
 * caller wants, so all of them are unioned into one request. A currency needing
 * less gets a few harmless extra rows.
 *
 * Once a currency's history reaches back far enough it is excluded from every
 * later call, which is what keeps a nightly run from re-downloading everything.
 */
export const backfillFxRates = async (
  db: Db,
  opts: { fetchImpl?: FetchImpl } = {},
): Promise<BackfillFxResult> => {
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Sequential rather than a Promise.all: D1 charges per statement either way,
  // and a currency list is short. Keeping the order makes a failure reproducible.
  const pending: [Currency, string][] = [];
  for (const [currency, earliestNeeded] of await earliestNeededDateByCurrency(db)) {
    if (await needsFxBackfill(db, currency, earliestNeeded))
      pending.push([currency, earliestNeeded]);
  }
  if (pending.length === 0) return { inserted: 0, currencies: 0 };

  const wanted = new Set<string>(pending.map(([currency]) => currency));
  const since = earliestOf(pending.map(([, earliestNeeded]) => earliestNeeded));
  // SAFETY: `pending` is non-empty (checked above), so `earliestOf` always has at least one
  // date to compare and cannot return `null`.
  if (since === null) return { inserted: 0, currencies: 0 };

  const rows = await fetchEcbRates(fetchImpl, wanted, since);
  const inserted = await insertFxRates(db, rows);
  return { inserted, currencies: pending.length };
};

/**
 * A rate for `currency` on or before `date`, fetching on demand when there is none.
 *
 * Breaks a deadlock: the sweeps above fetch only currencies the ledger already
 * holds, but a currency's first transaction is the row that would introduce it,
 * and a commit refused that row for having no rate.
 *
 * The daily file first, which covers a recent trade; the historical file when the
 * date is older than it publishes. Older than 1999 still returns null.
 *
 * A fetch failure degrades to null rather than throwing: an outage during an
 * import must reach the caller as its own refusal, not a raw network error.
 */
export const ensureFxRate = async (
  db: Db,
  currency: Currency,
  date: string,
  fetchImpl: FetchImpl,
): Promise<number | null> => {
  const existing = await fxRateOn(db, currency, date);
  if (existing !== null) return existing;

  try {
    // One ranged request covers both cases the old daily/historical two-step handled: a
    // recent trade and a back-dated one differ only in how far back `date` reaches.
    const rows = await fetchEcbRates(fetchImpl, new Set([currency]), date);
    await insertFxRates(db, rows);
    return await fxRateOn(db, currency, date);
  } catch {
    return null;
  }
};
