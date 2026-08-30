import type { getDb } from "../db/index.ts";
import { backfillFxRates } from "../fx.ts";
import { backfillMany } from "../prices/refresh.ts";
import type { FetchImpl } from "../prices/types.ts";
import type { Draft } from "./map.ts";

type Db = ReturnType<typeof getDb>["db"];

/**
 * The import-commit trigger for backfill (spec §10 item 7 / §6 "Backfill": "on first import of
 * an instrument, fetch history back to its earliest transaction"). Called by
 * `src/server/api/imports.ts` right after `commitDraft` resolves, for every commit route (CSV
 * and OP-paste alike) -- this is the one moment an instrument's earliest transaction date is
 * actually known, since a row can only commit once its instrument already exists (an unknown
 * ISIN refuses the whole commit -- see commit.ts's `unknownIsins` check), and a commit is what
 * puts the first (or an earlier) transaction into the ledger.
 *
 * `draft.txns` -- not `commitDraft`'s own `CommitResult` -- is deliberately what decides which
 * instruments to consider: even a re-import where every row is skipped as a duplicate still
 * names the same instruments, and a duplicate skip is exactly "this instrument's earliest
 * transaction date is already known, nothing new to insert" -- re-importing an old export is
 * documented (README, "Importing transactions") as a safe, ordinary thing to do, and is exactly
 * how an instrument that predates this feature (or whose backfill previously failed) gets
 * caught up without waiting for the nightly sweep. `backfillMany`'s own `needsBackfill` check is
 * what actually decides whether a network call happens at all -- an instrument whose history
 * already reaches its earliest transaction, or one that is `manual`/`nordnet_fund`/`op_fund`, is
 * a no-op here, so a routine re-import costs nothing extra.
 *
 * Also fires `fx.ts`'s `backfillFxRates` (the historical-file counterpart to the nightly
 * job's daily FX fetch) right after any instrument backfill above: a fresh commit is exactly
 * the other moment (besides the nightly sweep) a currency's own earliest-needed date can
 * newly extend further into the past, e.g. importing a EUR-booked, SEK-quoted holding whose
 * earliest transaction predates every fx_rates row SEK has so far -- so the same event that
 * gives an instrument's price history a new starting point gives that currency's fx history
 * one too, and both catch up together rather than one waiting for the next nightly run.
 * Unlike `backfillMany`, `backfillFxRates` does not isolate its own failure internally (it
 * mirrors `refreshFxRates`'s style, relying on its caller for that), so it is wrapped in its
 * own try/catch here -- this function's "never rejects" contract must hold regardless of
 * which of the two backfills it triggers actually fails.
 *
 * **Never awaited by its caller.** `backfillMany` already isolates each instrument's own
 * failure (never throws), but the point of not awaiting this at all is latency, not just
 * safety: a first import of several new instruments can mean several years-long fetches, and
 * this project's own constraint is that backfill must never add that wait to the response the
 * import's caller is sitting on. The caller instead does
 * `void backfillCommittedInstruments(db, draft).catch(...)` immediately after `commitDraft`
 * resolves and returns its response without waiting -- exported here (rather than inlined at
 * each of the two call sites) both to keep that one line identical at both, and so
 * backfill-on-commit.test.ts can `await` it directly for a deterministic assertion, instead of
 * racing a fire-and-forget promise the way an HTTP-level test would have to.
 */
export const backfillCommittedInstruments = async (
  db: Db,
  draft: Draft,
  opts: { fetchImpl?: FetchImpl } = {},
): Promise<void> => {
  const instrumentIds = [
    ...new Set(draft.txns.flatMap((row) => (row.instrumentId === null ? [] : [row.instrumentId]))),
  ];
  if (instrumentIds.length > 0) {
    await backfillMany(db, instrumentIds, opts);
  }
  try {
    await backfillFxRates(db, opts);
  } catch (cause) {
    console.error("FX-historian täydennys tuonnin jälkeen epäonnistui odottamattomasti", cause);
  }
};
