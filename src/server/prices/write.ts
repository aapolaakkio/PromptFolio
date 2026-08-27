import { and, desc, eq, lt } from "drizzle-orm";

import type { Currency } from "../../core/money";
import type { getDb } from "../db";
import { prices } from "../db/schema";
import type { FetchedPrice } from "./types";

type Db = ReturnType<typeof getDb>["db"];

/**
 * The minimal query surface `writePrices` needs from a transaction handle
 * (`select`, to read the baseline the plausibility check compares
 * against, and `insert`, to write the row). Mirrors
 * `src/server/import/commit.ts`'s `TxDb` -- `db.transaction()`'s callback
 * parameter is a `SQLiteAsyncTransaction`, not assignable to `Db` itself,
 * so any helper called *with* that callback's `tx` (rather than written
 * inline inside the callback) needs a type both `Db` and `tx` satisfy
 * structurally.
 */
type TxDb = Pick<Db, "select" | "insert">;

export type WriteOutcome = {
  readonly written: number;
  readonly rejectedImplausible: number;
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
 * corruption: the point is simply not written, the instrument keeps its
 * last known price with `price_fetch_log` recording exactly why (see
 * `refresh.ts`), which is this project's own documented degrade path --
 * "a missing price degrades to the most recent stored one with a stale
 * marker." A human can then override it with the real price. Accepting a
 * false one silently, on the other hand, is exactly "a silently wrong
 * total" -- the one outcome this project's constraints rule out
 * outright. Between a rare false rejection (safe, visible, recoverable)
 * and a rare false acceptance (a financial total silently off by an
 * order of magnitude), this project takes the former.
 */
export const MAX_PLAUSIBLE_RATIO = 10;

const isPlausibleMove = (previousMinor: number, nextMinor: number): boolean =>
  nextMinor <= previousMinor * MAX_PLAUSIBLE_RATIO &&
  nextMinor * MAX_PLAUSIBLE_RATIO >= previousMinor;

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

/**
 * Writes fetched price points for one instrument, upserting by
 * `(instrumentId, date)` -- a re-run for a date already stored overwrites
 * rather than duplicating (both `refreshPrices`' daily re-run and
 * `backfillInstrument`'s history rely on this).
 *
 * Points are written in date order, one insert per point, inside a single
 * transaction. The plausibility baseline for each point is read fresh
 * from the database immediately before that point is written -- not
 * carried in memory -- so an earlier point from *this same batch*, once
 * written, is already visible as the baseline for the next one (SQLite
 * sees a transaction's own prior writes; verified directly against this
 * project's real `testDb()` before relying on it). This matters for
 * `backfillInstrument`, whose batch can be years of daily closes: each
 * day is checked against the actual immediately-preceding day, not
 * against some earlier snapshot.
 *
 * A point whose close fails the plausibility check (see
 * `MAX_PLAUSIBLE_RATIO`) is not written at all -- the instrument keeps
 * whatever price it already had for that date (or none), and the
 * rejection is reported back via `rejectedImplausible` for the caller to
 * log, not silently dropped. The very first price ever stored for an
 * instrument has no baseline to compare against and is always accepted,
 * matching Task 14's own reasoning: no historical context, no check
 * possible. A baseline in a different currency than the new point is
 * also never compared -- a currency change is not what this check exists
 * to catch, and comparing across currencies would be meaningless.
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
  db.transaction((tx) => {
    for (const point of sorted) {
      const baseline = mostRecentPriceBefore(tx, instrumentId, point.date);
      if (
        baseline &&
        baseline.currency === point.currency &&
        !isPlausibleMove(baseline.close, point.closeMinor)
      ) {
        rejectedImplausible++;
        continue;
      }
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
      written++;
    }
  });
  return { written, rejectedImplausible };
};
