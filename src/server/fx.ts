import { and, asc, desc, eq, lte } from "drizzle-orm";

import { EUR, type Currency } from "../core/money.ts";
import type { Db } from "./db/index.ts";
import { fxRates, instruments, transactions } from "./db/schema.ts";
import { fetchEcbRates, type EcbRow } from "./fx-ecb.ts";
import type { FetchImpl } from "./prices/types.ts";

/** Lookback of the nightly refresh: covers a missed run over a long weekend; anything older is backfillFxRates' job. */
const REFRESH_WINDOW_DAYS = 10;

/** An ISO date `days` before today. */
const isoDaysAgo = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** Inserts rows idempotently (primary key `(date, currency)`) and returns the count inserted. Shared by the scheduled job and `ensureFxRate`. */
const insertFxRates = async (db: Db, rows: readonly EcbRow[]): Promise<number> => {
  const statements = rows
    // Defense in depth: a meaningless EUR/EUR row must never reach this table, even if the parser slips.
    .filter((row) => row.currency !== EUR)
    .map((row) =>
      db
        .insert(fxRates)
        .values({ date: row.date, currency: row.currency, rateEur: row.rateEur })
        .onConflictDoNothing()
        // D1 batches cannot report a row count, so an empty `returning` means a conflict.
        .returning({ date: fxRates.date }),
    );
  if (statements.length === 0) return 0;

  // One batch: D1 runs it as a single transaction, so a failure rolls everything back.
  // SAFETY: `db.batch` wants a non-empty tuple; the `length === 0` return above establishes it.
  const results = await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
  return results.reduce((count, inserted) => count + inserted.length, 0);
};

/** The newest rate for `currency` on or before `date`, or null. Takes only `select`, so a transaction's `tx` can be passed in. */
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
 * ECB's daily rates for every non-EUR currency the ledger holds (a transaction's currency or an instrument's quotation
 * currency: a EUR-booked SEK-quoted fund never puts SEK on a transaction), idempotently.
 * No network call when there is nothing to convert.
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

  // A short trailing window: nightly runs only need what ECB published since the last one.
  const rows = await fetchEcbRates(fetchImpl, wanted, isoDaysAgo(REFRESH_WINDOW_DAYS));
  const inserted = await insertFxRates(db, rows);
  return { inserted };
};

/** Sets `map[currency]` to `date` if it is earlier than what is already stored (or nothing is). */
const bumpEarliest = (map: Map<Currency, string>, currency: Currency, date: string): void => {
  const existing = map.get(currency);
  if (existing === undefined || date < existing) map.set(currency, date);
};

/** The earliest date each held currency must be convertible on: its first held position. A currency on an instrument nobody holds is absent. */
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

/** True when `currency`'s stored history does not reach `earliestNeeded` (no row, or the earliest is later). Keeps backfill cheap on ordinary nights. */
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

type BackfillFxResult = { readonly inserted: number; readonly currencies: number };

/**
 * Every held currency's history back to the earliest date the ledger needs.
 * One combined fetch (ECB serves every currency in one response); a currency that already
 * reaches back far enough is excluded from later calls.
 */
export const backfillFxRates = async (
  db: Db,
  opts: { fetchImpl?: FetchImpl } = {},
): Promise<BackfillFxResult> => {
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Sequential: D1 charges per statement either way, and the order makes a failure reproducible.
  const pending: [Currency, string][] = [];
  for (const [currency, earliestNeeded] of await earliestNeededDateByCurrency(db)) {
    if (await needsFxBackfill(db, currency, earliestNeeded))
      pending.push([currency, earliestNeeded]);
  }
  if (pending.length === 0) return { inserted: 0, currencies: 0 };

  const wanted = new Set<string>(pending.map(([currency]) => currency));
  const since = earliestOf(pending.map(([, earliestNeeded]) => earliestNeeded));
  // SAFETY: `pending` is non-empty (checked above), so `earliestOf` cannot return null.
  if (since === null) return { inserted: 0, currencies: 0 };

  const rows = await fetchEcbRates(fetchImpl, wanted, since);
  const inserted = await insertFxRates(db, rows);
  return { inserted, currencies: pending.length };
};

/**
 * A rate for `currency` on or before `date`, fetching on demand when there is none.
 * Breaks a deadlock: the sweeps fetch only held currencies, but a currency's first transaction is what introduces it.
 * Older than 1999 still gives null.
 * A fetch failure degrades to null so an import gets a refusal, not a raw network error.
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
    // One ranged request covers a recent and a back-dated trade alike.
    const rows = await fetchEcbRates(fetchImpl, new Set([currency]), date);
    await insertFxRates(db, rows);
    return await fxRateOn(db, currency, date);
  } catch {
    return null;
  }
};
