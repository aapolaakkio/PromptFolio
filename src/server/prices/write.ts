import { and, desc, eq, lt } from "drizzle-orm";

import type { Currency } from "../../core/money.ts";
import type { Db } from "../db/index.ts";
import { pendingPriceRejections, prices } from "../db/schema.ts";
import type { FetchedPrice } from "./types.ts";

// The helpers below only ever read and write; naming that keeps them callable
// with anything database-shaped.
type TxDb = Pick<Db, "select" | "insert" | "delete">;

export type WriteOutcome = {
  readonly written: number;
  readonly rejectedImplausible: number;
  /** Of `written`, how many came through the re-baseline path. Log these loudly. */
  readonly reBaselined: number;
};

/**
 * A single fetch has no history to check itself against; this layer does.
 *
 * Every scraper bug this project has actually hit is structural -- a decimal
 * read one place over, cents against whole units, the wrong column -- and those
 * are off by an order of magnitude, not a few percent. A tighter threshold
 * would be a guess about this portfolio's volatility; 10x is not.
 */
export const MAX_PLAUSIBLE_RATIO = 10;

const isPlausibleMove = (previousMinor: number, nextMinor: number): boolean =>
  nextMinor <= previousMinor * MAX_PLAUSIBLE_RATIO &&
  nextMinor * MAX_PLAUSIBLE_RATIO >= previousMinor;

/**
 * How many consistent readings at a new scale it takes to accept it as real.
 *
 * Comparing only against the last stored price freezes an instrument forever
 * after a genuine permanent change -- a steep split, a fund re-denominating --
 * and there is no UI anywhere to unstick a price by hand. Persistence tells the
 * two apart, not magnitude: a transient glitch does not recur at the same new
 * scale across separate scheduled fetches, a real split reports it every day.
 *
 * Three, because the job runs once a weekday: two would not rule out one cached
 * bad response served twice, and more would leave the chart stale for weeks.
 *
 * A persistent scraper bug looks identical to a split by this signal. That is
 * an accepted limit -- only a human reading the re-baseline log can tell them
 * apart. Consulting the ledger for a SPLIT row would couple this layer to it
 * and would not help a re-denomination, which has no such row.
 */
export const RE_BASELINE_CONFIRMATIONS = 3;

type PendingRejection = {
  readonly close: number;
  readonly currency: Currency;
  readonly streak: number;
};

const pendingRejectionFor = (
  tx: TxDb,
  instrumentId: number,
): Promise<PendingRejection | undefined> =>
  tx
    .select({
      close: pendingPriceRejections.close,
      currency: pendingPriceRejections.currency,
      streak: pendingPriceRejections.streak,
    })
    .from(pendingPriceRejections)
    .where(eq(pendingPriceRejections.instrumentId, instrumentId))
    .get();

const clearPendingRejection = async (tx: TxDb, instrumentId: number): Promise<void> => {
  await tx
    .delete(pendingPriceRejections)
    .where(eq(pendingPriceRejections.instrumentId, instrumentId))
    .run();
};

/** Records `point` as the (possibly new) pending candidate, at `streak` confirmations so far. */
const recordPendingRejection = async (
  tx: TxDb,
  instrumentId: number,
  point: FetchedPrice,
  streak: number,
): Promise<void> => {
  await tx
    .insert(pendingPriceRejections)
    .values({
      instrumentId,
      date: point.date,
      close: point.closeMinor,
      currency: point.currency,
      streak,
    })
    .onConflictDoUpdate({
      target: pendingPriceRejections.instrumentId,
      set: { date: point.date, close: point.closeMinor, currency: point.currency, streak },
    })
    .run();
};

type StoredPrice = { readonly close: number; readonly currency: Currency; readonly date: string };

/** Most recent stored price strictly before `date`, or undefined if this instrument has none yet. */
const mostRecentPriceBefore = (
  tx: TxDb,
  instrumentId: number,
  date: string,
): Promise<StoredPrice | undefined> =>
  tx
    .select({ close: prices.close, currency: prices.currency, date: prices.date })
    .from(prices)
    .where(and(eq(prices.instrumentId, instrumentId), lt(prices.date, date)))
    .orderBy(desc(prices.date))
    .limit(1)
    .get();

const upsertPrice = async (
  tx: TxDb,
  instrumentId: number,
  source: string,
  point: FetchedPrice,
): Promise<void> => {
  await tx
    .insert(prices)
    .values({
      instrumentId,
      date: point.date,
      close: point.closeMinor,
      currency: point.currency,
      source,
      fetchedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [prices.instrumentId, prices.date],
      set: { close: point.closeMinor, currency: point.currency, source, fetchedAt: new Date() },
    })
    .run();
};

/**
 * Writes a point without the guard, for a price a person typed in.
 *
 * The guard exists for a scraper returning a structurally wrong number, which
 * is not what a human correcting a price on screen is doing -- and waiting for
 * three confirmations means asking them to submit the same fix on three
 * separate days. A feature whose job is fixing a wrong price cannot refuse the
 * fix. Every automated caller omits the option, so scraped output is still
 * fully checked, and `requirePositiveMinor` still runs either way.
 */
const acceptUnconditionally = async (
  tx: TxDb,
  instrumentId: number,
  source: string,
  point: FetchedPrice,
): Promise<"written"> => {
  await upsertPrice(tx, instrumentId, source, point);
  await clearPendingRejection(tx, instrumentId);
  return "written";
};

/** Decides one point against the stored baseline and any pending streak. */
const resolvePoint = async (
  tx: TxDb,
  instrumentId: number,
  source: string,
  point: FetchedPrice,
  plausibleOnly: boolean,
): Promise<"written" | "rejected" | "reBaselined"> => {
  const baseline = await mostRecentPriceBefore(tx, instrumentId, point.date);
  const plausibleVsBaseline =
    !baseline ||
    baseline.currency !== point.currency ||
    isPlausibleMove(baseline.close, point.closeMinor);

  if (plausibleVsBaseline) {
    // Accepting normally unsticks the instrument, so a pending streak is moot.
    await upsertPrice(tx, instrumentId, source, point);
    await clearPendingRejection(tx, instrumentId);
    return "written";
  }
  if (plausibleOnly) return "rejected";

  const pending = await pendingRejectionFor(tx, instrumentId);
  const continuesPendingStreak =
    pending &&
    pending.currency === point.currency &&
    isPlausibleMove(pending.close, point.closeMinor);

  if (!continuesPendingStreak) {
    // A fresh anomaly, unrelated to whatever was pending: count from 1 again.
    await recordPendingRejection(tx, instrumentId, point, 1);
    return "rejected";
  }

  const streak = pending.streak + 1;
  if (streak < RE_BASELINE_CONFIRMATIONS) {
    await recordPendingRejection(tx, instrumentId, point, streak);
    return "rejected";
  }

  // Enough consistent readings at this scale: it is the real new baseline.
  await upsertPrice(tx, instrumentId, source, point);
  await clearPendingRejection(tx, instrumentId);
  return "reBaselined";
};

/**
 * Writes one instrument's points, upserting by `(instrumentId, date)`.
 *
 * Each point's baseline and streak are read fresh from the database rather than
 * carried in memory, so an earlier point in the same batch is already visible to
 * the next -- which matters for a backfill spanning years of daily closes.
 *
 * An implausible point is not written and is reported back, never silently
 * dropped. The first price ever stored has no baseline and is always accepted,
 * as is a point in a different currency than the baseline.
 */
export const writePrices = async (
  db: Db,
  instrumentId: number,
  source: string,
  points: readonly FetchedPrice[],
  opts: {
    readonly skipPlausibilityCheck?: boolean;
    /**
     * Refuse an implausible point without counting it toward a re-baseline,
     * and leave any pending streak as it was. For the intraday run:
     * `RE_BASELINE_CONFIRMATIONS` counts once-a-weekday readings, and a run
     * every 15 minutes would confirm a bad quote served for 45 minutes.
     */
    readonly plausibleOnly?: boolean;
  } = {},
): Promise<WriteOutcome> => {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));

  let written = 0;
  let rejectedImplausible = 0;
  let reBaselined = 0;
  // ponytail: no transaction -- D1 rejects BEGIN, and each point has to see
  // what the point before it wrote, which `db.batch()` cannot express. So each
  // statement auto-commits: a failure part-way leaves the earlier points
  // written. Prices are idempotent upserts, so re-running the fetch repairs it.
  // Upgrade path if that is not good enough: decide the whole run in memory
  // against one read of the history, then write it as a single batch.
  for (const point of sorted) {
    const outcome = opts.skipPlausibilityCheck
      ? await acceptUnconditionally(db, instrumentId, source, point)
      : await resolvePoint(db, instrumentId, source, point, opts.plausibleOnly ?? false);
    if (outcome === "written") written++;
    else if (outcome === "reBaselined") {
      written++;
      reBaselined++;
    } else {
      rejectedImplausible++;
    }
  }
  return { written, rejectedImplausible, reBaselined };
};
