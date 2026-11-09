import { and, desc, eq, lt } from "drizzle-orm";

import type { Currency } from "../../core/money.ts";
import type { Db } from "../db/index.ts";
import { pendingPriceRejections, prices } from "../db/schema.ts";
import type { FetchedPrice } from "./types.ts";

// Read/write only, so callable with anything database-shaped.
type TxDb = Pick<Db, "select" | "insert" | "delete">;

type WriteOutcome = {
  readonly written: number;
  readonly rejectedImplausible: number;
  readonly reBaselined: number;
};

/** Structural scraper bugs are off by an order of magnitude, so 10x is the guard rather than a guess at volatility. */
export const MAX_PLAUSIBLE_RATIO = 10;

export const isPlausibleMove = (previousMinor: number, nextMinor: number): boolean =>
  nextMinor <= previousMinor * MAX_PLAUSIBLE_RATIO &&
  nextMinor * MAX_PLAUSIBLE_RATIO >= previousMinor;

/**
 * Consistent readings at a new scale needed to accept it, so a real split or re-denomination
 * cannot freeze an instrument forever (no UI can unstick a price). Three, as the job runs once a
 * weekday: two would not rule out one cached bad response served twice.
 * A persistent scraper bug looks like a split here; only the re-baseline log tells them apart.
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

/** Writes a point without the guard, for a price a person typed in (a fix must not wait three days). `requirePositiveMinor` still runs. */
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
    await recordPendingRejection(tx, instrumentId, point, 1);
    return "rejected";
  }

  const streak = pending.streak + 1;
  if (streak < RE_BASELINE_CONFIRMATIONS) {
    await recordPendingRejection(tx, instrumentId, point, streak);
    return "rejected";
  }

  await upsertPrice(tx, instrumentId, source, point);
  await clearPendingRejection(tx, instrumentId);
  return "reBaselined";
};

/** Upserts one instrument's points by `(instrumentId, date)`. Each baseline is read fresh so earlier points in the batch count. Implausible points are reported back; the first price and a currency change are always accepted. */
export const writePrices = async (
  db: Db,
  instrumentId: number,
  source: string,
  points: readonly FetchedPrice[],
  opts: {
    readonly skipPlausibilityCheck?: boolean;
    /** Refuse implausible points without counting toward a re-baseline: hourly runs must not confirm a bad quote. */
    readonly plausibleOnly?: boolean;
  } = {},
): Promise<WriteOutcome> => {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));

  let written = 0;
  let rejectedImplausible = 0;
  let reBaselined = 0;
  // ponytail: no transaction (D1 rejects BEGIN; each point must see the one before). A partial failure is repaired by re-running, as upserts are idempotent.
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
