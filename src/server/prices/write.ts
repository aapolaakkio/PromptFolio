import { and, desc, eq, lt } from "drizzle-orm";

import type { Currency } from "../../core/money";
import type { getDb } from "../db";
import { pendingPriceRejections, prices } from "../db/schema";
import type { FetchedPrice } from "./types";

type Db = ReturnType<typeof getDb>["db"];

/**
 * The minimal query surface `writePrices` needs from a transaction handle
 * (`select`/`insert` for the price row and the pending-rejection row,
 * `delete` to clear a resolved pending row). Mirrors
 * `src/server/import/commit.ts`'s `TxDb` -- `db.transaction()`'s callback
 * parameter is a `SQLiteAsyncTransaction`, not assignable to `Db` itself,
 * so any helper called *with* that callback's `tx` (rather than written
 * inline inside the callback) needs a type both `Db` and `tx` satisfy
 * structurally.
 */
type TxDb = Pick<Db, "select" | "insert" | "delete">;

export type WriteOutcome = {
  readonly written: number;
  readonly rejectedImplausible: number;
  /**
   * How many of `written` were accepted specifically via the re-baseline
   * path (`RE_BASELINE_CONFIRMATIONS` consecutive consistent
   * observations), not an ordinary plausible day-over-day move. Always
   * `<= written`. A caller should log this loudly -- see `refresh.ts`.
   */
  readonly reBaselined: number;
};

/**
 * ## The large-jump sanity check (Task 15, point 5)
 *
 * Task 14's `requirePositiveMinor` (types.ts) rejects a zero/negative
 * close but deliberately does *not* reject an implausibly large jump,
 * because a single fetch has no prior value to compare against -- "that
 * check belongs at a layer with historical context." This is that layer:
 * `writePrices` is the one place that writes into `prices`, a table that
 * already holds every instrument's prior close, so it can compare.
 *
 * **What this guards against, concretely.** Every scraper-shaped bug this
 * project has actually hit so far (Task 14's zero/negative closes; the
 * wrong-column Nordnet `Valuutta` mix-up in §10a A2) is a *structural*
 * misread, not a plausible-but-wrong number: a decimal point read one
 * place over, a value read in the wrong minor-unit scale (cents vs.
 * whole units), a NAV field swapped for a different one entirely. Every
 * one of those produces a value that is off by a whole order of
 * magnitude or more, not by a few percent. A single-digit percentage
 * threshold would be exactly the kind of unverified guess Task 14
 * declined to invent (it cannot be justified without knowing this
 * portfolio's real historical daily volatility, which this task has no
 * more evidence for than Task 14 did) -- but "off by 10x or more" is not
 * a volatility question, it is the specific, observed shape of this
 * project's actual bug class.
 *
 * **Why 10x, and not tighter.** A genuine 10x-or-more single-day move
 * requires either a >=90% crash (essentially never, for a diversified
 * fund/ETF; individual stocks occasionally gap far on binary news, but
 * this portfolio per §10a is fund/ETF/stock holdings, not speculative
 * single names) or a stock split/reverse split of ratio 10:1 or steeper,
 * which is rare but real. Rejecting a genuine one is not silent
 * corruption -- see `RE_BASELINE_CONFIRMATIONS` below for how a genuine
 * one now recovers on its own, rather than freezing forever. Accepting a
 * false one silently, on the other hand, is exactly "a silently wrong
 * total" -- the one outcome this project's constraints rule out
 * outright. Between a rare false rejection (safe, visible, and now
 * self-correcting) and a rare false acceptance (a financial total
 * silently off by an order of magnitude), this project takes the former.
 */
export const MAX_PLAUSIBLE_RATIO = 10;

const isPlausibleMove = (previousMinor: number, nextMinor: number): boolean =>
  nextMinor <= previousMinor * MAX_PLAUSIBLE_RATIO &&
  nextMinor * MAX_PLAUSIBLE_RATIO >= previousMinor;

/**
 * ## Making a rejection self-healing (Task 15 review fix)
 *
 * The plausibility check above compares only against the last *stored*
 * price. Left there, a genuine permanent change -- a stock split steeper
 * than 10:1, a reverse split, a fund re-denominating its NAV per 100
 * units -- freezes forever: every later real price is compared against
 * the same stale stored baseline and rejected too, and this app has no
 * price-correction UI anywhere to unstick it by hand (`instruments.ts`
 * exposes `priceSource`, never a price value). An unattended nightly job
 * discovering that months later, with the chart quietly wrong the whole
 * time, is worse than the false-rejection risk this check exists to
 * avoid in the first place.
 *
 * **The signal used to tell the two cases apart is persistence, not
 * magnitude** -- magnitude alone cannot distinguish a real 10:1 split
 * from a decimal-shift bug, since both produce the same single implausible
 * ratio. But a *transient* glitch (a malformed one-off response, a
 * momentary parsing race) is extremely unlikely to recur at a
 * consistent new scale across several separate, independent fetches; a
 * real split or re-denomination reports that same new scale every single
 * day from the day it takes effect, permanently. So: `writePrices`
 * tracks a rejected value in `pending_price_rejections` (one row per
 * instrument) and only re-baselines once the same new scale has been
 * seen `RE_BASELINE_CONFIRMATIONS` times in a row -- each confirmation
 * checked against the *previous pending candidate*, not the original
 * frozen baseline, using this same `isPlausibleMove` (so day-to-day
 * movement *at* the new scale is still allowed between confirmations,
 * exactly as it would be at the old scale). A confirming value does not
 * need to be numerically identical, only plausible relative to the prior
 * one -- that is what "the same new scale" means for a real security
 * that keeps trading.
 *
 * **Why 3, not fewer or more.** `refreshPrices` runs once per weekday
 * evening (see `refresh.ts`), so "N confirmations" is roughly N market
 * days, not N hours -- the chart stays visibly stale for that long
 * before a genuine change resolves. This is a real cost of picking N
 * too high. Picking N too low trades that away for false-positive risk:
 * N=1 would mean no confirmation at all (identical to no self-healing).
 * N=2 accepts on the very next fetch after the first rejection, which
 * does not rule out two glitches in a row from the very same underlying
 * cause (e.g. a CDN serving one cached bad response across two
 * consecutive scheduled fetches a day apart -- a real, observed failure
 * mode for scraped pages, not a hypothetical one). N=3 requires that
 * same wrong scale to independently reproduce across three separate
 * scheduled runs -- roughly a business week accounting for weekends --
 * which is a much less likely coincidence for a transient bug while
 * still resolving a real split within days rather than weeks. This is
 * also a standard, unremarkable "three strikes" confirmation count in
 * monitoring/alerting generally, not a number invented for this
 * codebase specifically.
 *
 * **What this does not solve, by design.** A *persistent* scraper bug
 * (a page template change that breaks a selector in a way that
 * consistently produces the same wrong scale every day until a human
 * fixes the code) is indistinguishable from a real split by this same
 * signal -- both look like N consistent consecutive readings. Nothing
 * in "did it repeat" alone can tell those apart; only a human reading
 * the loud log entry this produces (`refresh.ts` logs every
 * re-baseline distinctly) can. That is an explicit, accepted limit of
 * this fix, not an oversight: the alternative -- consulting
 * `transactions` for a nearby `SPLIT` row -- was considered and
 * rejected, because it couples this price layer to the ledger and would
 * not help a fund re-denomination at all, which has no `SPLIT`
 * transaction to find.
 */
export const RE_BASELINE_CONFIRMATIONS = 3;

type PendingRejection = {
  readonly close: number;
  readonly currency: Currency;
  readonly streak: number;
};

const pendingRejectionFor = (tx: TxDb, instrumentId: number): PendingRejection | undefined =>
  tx
    .select({
      close: pendingPriceRejections.close,
      currency: pendingPriceRejections.currency,
      streak: pendingPriceRejections.streak,
    })
    .from(pendingPriceRejections)
    .where(eq(pendingPriceRejections.instrumentId, instrumentId))
    .get();

const clearPendingRejection = (tx: TxDb, instrumentId: number): void => {
  tx.delete(pendingPriceRejections)
    .where(eq(pendingPriceRejections.instrumentId, instrumentId))
    .run();
};

/** Records `point` as the (possibly new) pending candidate, at `streak` confirmations so far. */
const recordPendingRejection = (
  tx: TxDb,
  instrumentId: number,
  point: FetchedPrice,
  streak: number,
): void => {
  tx.insert(pendingPriceRejections)
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
): StoredPrice | undefined =>
  tx
    .select({ close: prices.close, currency: prices.currency, date: prices.date })
    .from(prices)
    .where(and(eq(prices.instrumentId, instrumentId), lt(prices.date, date)))
    .orderBy(desc(prices.date))
    .limit(1)
    .get();

const upsertPrice = (tx: TxDb, instrumentId: number, source: string, point: FetchedPrice): void => {
  tx.insert(prices)
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
 * Decides one point's fate against the stored baseline and any pending
 * rejection streak, mutating `pending_price_rejections` as needed.
 * Returns which outcome happened so the caller can total it up.
 */
const resolvePoint = (
  tx: TxDb,
  instrumentId: number,
  source: string,
  point: FetchedPrice,
): "written" | "rejected" | "reBaselined" => {
  const baseline = mostRecentPriceBefore(tx, instrumentId, point.date);
  const plausibleVsBaseline =
    !baseline ||
    baseline.currency !== point.currency ||
    isPlausibleMove(baseline.close, point.closeMinor);

  if (plausibleVsBaseline) {
    // Either a normal move, no baseline yet, or a currency change (never
    // checked -- see MAX_PLAUSIBLE_RATIO's doc comment). Any in-flight
    // pending streak is moot once a value is accepted normally: the
    // instrument is no longer stuck, so there is nothing left to confirm.
    upsertPrice(tx, instrumentId, source, point);
    clearPendingRejection(tx, instrumentId);
    return "written";
  }

  const pending = pendingRejectionFor(tx, instrumentId);
  const continuesPendingStreak =
    pending &&
    pending.currency === point.currency &&
    isPlausibleMove(pending.close, point.closeMinor);

  if (!continuesPendingStreak) {
    // A fresh anomaly, unrelated to whatever was pending (if anything):
    // start counting from 1 again.
    recordPendingRejection(tx, instrumentId, point, 1);
    return "rejected";
  }

  const streak = pending.streak + 1;
  if (streak < RE_BASELINE_CONFIRMATIONS) {
    recordPendingRejection(tx, instrumentId, point, streak);
    return "rejected";
  }

  // RE_BASELINE_CONFIRMATIONS consecutive, mutually consistent
  // observations at this new scale: accept it as the real, permanent new
  // baseline and stop tracking it as pending.
  upsertPrice(tx, instrumentId, source, point);
  clearPendingRejection(tx, instrumentId);
  return "reBaselined";
};

/**
 * Writes fetched price points for one instrument, upserting by
 * `(instrumentId, date)` -- a re-run for a date already stored overwrites
 * rather than duplicating (both `refreshPrices`' daily re-run and
 * `backfillInstrument`'s history rely on this).
 *
 * Points are written in date order, one decision per point, inside a
 * single transaction. Both the plausibility baseline and any pending
 * rejection streak are read fresh from the database immediately before
 * each point is resolved -- not carried in memory -- so an earlier point
 * from *this same batch*, once written, is already visible to the next
 * one (SQLite sees a transaction's own prior writes; verified directly
 * against this project's real `testDb()` before relying on it). This
 * matters for `backfillInstrument`, whose batch can be years of daily
 * closes: each day is checked against the actual immediately-preceding
 * day, not against some earlier snapshot.
 *
 * A point whose close fails the plausibility check (see
 * `MAX_PLAUSIBLE_RATIO`) is not written -- the instrument keeps whatever
 * price it already had for that date (or none) -- unless it is the
 * `RE_BASELINE_CONFIRMATIONS`th consecutive consistent observation of
 * the same new scale, in which case it *is* written and the rejection
 * streak clears (see `RE_BASELINE_CONFIRMATIONS`'s doc comment for the
 * full reasoning). Both outcomes are reported back (`rejectedImplausible`,
 * `reBaselined`) for the caller to log, never silently dropped. The very
 * first price ever stored for an instrument has no baseline to compare
 * against and is always accepted, matching Task 14's own reasoning: no
 * historical context, no check possible. A baseline in a different
 * currency than the new point is also never compared -- a currency
 * change is not what this check exists to catch.
 */
export const writePrices = (
  db: Db,
  instrumentId: number,
  source: string,
  points: readonly FetchedPrice[],
): WriteOutcome => {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));

  let written = 0;
  let rejectedImplausible = 0;
  let reBaselined = 0;
  db.transaction((tx) => {
    for (const point of sorted) {
      const outcome = resolvePoint(tx, instrumentId, source, point);
      if (outcome === "written") written++;
      else if (outcome === "reBaselined") {
        written++;
        reBaselined++;
      } else {
        rejectedImplausible++;
      }
    }
  });
  return { written, rejectedImplausible, reBaselined };
};
