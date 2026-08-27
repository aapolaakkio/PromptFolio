import { asc, eq } from "drizzle-orm";
import type { CronJob } from "bun";

import type { getDb } from "../db";
import { instruments, priceFetchLog, prices, transactions } from "../db/schema";
import { backfillFxRates, refreshFxRates } from "../fx";
import { sourceFor } from "./registry";
import { SourceNotImplementedError, type FetchImpl, type FetchedPrice } from "./types";
import { MAX_PLAUSIBLE_RATIO, writePrices } from "./write";

type Db = ReturnType<typeof getDb>["db"];

const today = (): string => new Date().toISOString().slice(0, 10);

const logAttempt = (
  db: Db,
  args: {
    readonly source: string;
    readonly instrumentId: number;
    readonly ok: boolean;
    readonly message: string;
  },
): void => {
  db.insert(priceFetchLog)
    .values({
      source: args.source,
      instrumentId: args.instrumentId,
      runAt: new Date(),
      ok: args.ok,
      message: args.message,
    })
    .run();
};

/** Renders a cause caught from a `PriceSource.fetch()` call as a log message. */
const describeFailure = (cause: unknown): string => {
  if (cause instanceof SourceNotImplementedError) {
    // Point 4: kept distinct from a generic fetch failure via `instanceof`
    // -- not by string-matching `cause.message` -- so a caller can always
    // tell "not built" apart from "genuinely failed" even if the error's
    // own wording ever changes. See types.ts's SourceNotImplementedError
    // doc comment for why this class exists at all.
    return `Hintalähdettä ei ole vielä toteutettu: ${cause.message}`;
  }
  return cause instanceof Error ? cause.message : "Tuntematon virhe";
};

/**
 * Fetches today's price for every non-manual instrument and writes it,
 * isolating each instrument's attempt from every other's: one failing or
 * unimplemented source never stops the rest of the loop, and every
 * attempt -- success, failure, or not-yet-implemented -- writes exactly
 * one `price_fetch_log` row. `manual` instruments are the one exception:
 * they are skipped without a log row at all, since "manual" means a
 * human owns this instrument's price, not that a fetch was attempted and
 * found nothing.
 *
 * A point that fails Task 15's large-jump plausibility check
 * (`write.ts`) is reported as a failure here too, not folded silently
 * into a clean "ok": the fetch itself succeeded, but the data it
 * returned was not trusted, and that is exactly the kind of outcome this
 * project's `price_fetch_log` exists to surface rather than bury.
 */
export const refreshPrices = async (
  db: Db,
  opts: { fetchImpl?: FetchImpl; today?: string } = {},
): Promise<{ ok: number; failed: number }> => {
  const asOf = opts.today ?? today();
  let ok = 0;
  let failed = 0;

  for (const instrument of db.select().from(instruments).all()) {
    if (instrument.priceSource === "manual") continue;
    const source = sourceFor(instrument.priceSource);

    try {
      const points = await source.fetch({
        sourceKey: instrument.sourceKey,
        from: asOf,
        to: asOf,
        fetchImpl: opts.fetchImpl,
      });
      const { written, rejectedImplausible, reBaselined } = writePrices(
        db,
        instrument.id,
        source.id,
        points,
      );

      if (reBaselined > 0) {
        // Loud on purpose: this means a price that looked implausible was
        // just confirmed, `RE_BASELINE_CONFIRMATIONS` times in a row, as a
        // real, permanent change (a split, a re-denomination) -- worth a
        // human's attention even though the fetch itself succeeded and the
        // instrument is no longer stuck. See write.ts's
        // RE_BASELINE_CONFIRMATIONS doc comment.
        const message =
          `${written} hintapistettä tallennettu, näistä ${reBaselined} ` +
          `UUDELLEENPERUSTETTU vahvistetun pysyvän muutoksen jälkeen` +
          (rejectedImplausible > 0 ? ` (${rejectedImplausible} yhä hylätty)` : "");
        console.warn(
          `Hintasarja uudelleenperustettu: ${source.id} instrumentille ${instrument.id}`,
        );
        logAttempt(db, { source: source.id, instrumentId: instrument.id, ok: true, message });
        ok++;
      } else if (rejectedImplausible > 0) {
        failed++;
        logAttempt(db, {
          source: source.id,
          instrumentId: instrument.id,
          ok: false,
          message:
            `${written} hintapistettä tallennettu, ${rejectedImplausible} hylätty ` +
            `epäuskottavana hintahyppynä (yli ${MAX_PLAUSIBLE_RATIO}x)`,
        });
      } else {
        ok++;
        logAttempt(db, {
          source: source.id,
          instrumentId: instrument.id,
          ok: true,
          message: `${written} hintapistettä`,
        });
      }
    } catch (cause) {
      failed++;
      logAttempt(db, {
        source: source.id,
        instrumentId: instrument.id,
        ok: false,
        message: describeFailure(cause),
      });
    }
  }
  return { ok, failed };
};

/**
 * How many calendar days a real trading source may legitimately skip
 * (weekends, public holidays) between the requested start date and the
 * earliest price it actually returns, before that gap is treated as
 * "this source could not backfill the requested range" rather than
 * ordinary non-trading days. A week comfortably covers any single
 * holiday-adjacent weekend without needing a real trading calendar.
 */
const BACKFILL_GAP_TOLERANCE_DAYS = 7;

const daysBetween = (isoA: string, isoB: string): number =>
  Math.abs(Date.parse(`${isoA}T00:00:00Z`) - Date.parse(`${isoB}T00:00:00Z`)) / 86_400_000;

export type BackfillResult = {
  readonly inserted: number;
  /**
   * True when the source did not actually cover the requested range --
   * either it returned nothing, or its earliest point is more than
   * `BACKFILL_GAP_TOLERANCE_DAYS` after the requested start. Point 3:
   * `nordnet_fund`'s public page carries only two NAV points (see
   * funds.ts's `NORDNET_FUND` comment) and can never backfill years of
   * history through this endpoint -- this flag is what makes that
   * limitation observable to a caller instead of a silently-successful
   * `{ inserted: 2 }` that looks the same as a real, complete backfill.
   * Detected generically (by comparing dates), not by special-casing
   * `nordnet_fund`'s id, so it also catches any future source with the
   * same limitation. A matching `price_fetch_log` row is written
   * whenever this is true, so the limitation is visible operationally
   * too, not only in this return value.
   */
  readonly incomplete: boolean;
};

/** Fetches history back to the instrument's earliest transaction and writes it. */
export const backfillInstrument = async (
  db: Db,
  instrumentId: number,
  opts: { fetchImpl?: FetchImpl; today?: string } = {},
): Promise<BackfillResult> => {
  const instrument = db.select().from(instruments).where(eq(instruments.id, instrumentId)).get();
  if (!instrument || instrument.priceSource === "manual") return { inserted: 0, incomplete: false };

  const earliest = db
    .select({ tradeDate: transactions.tradeDate })
    .from(transactions)
    .where(eq(transactions.instrumentId, instrumentId))
    .orderBy(asc(transactions.tradeDate))
    .limit(1)
    .get();
  if (!earliest) return { inserted: 0, incomplete: false };

  const from = earliest.tradeDate;
  const to = opts.today ?? today();
  const source = sourceFor(instrument.priceSource);

  let points: FetchedPrice[];
  try {
    points = await source.fetch({
      sourceKey: instrument.sourceKey,
      from,
      to,
      fetchImpl: opts.fetchImpl,
    });
  } catch (cause) {
    logAttempt(db, {
      source: source.id,
      instrumentId,
      ok: false,
      message: `Taustatäyttö epäonnistui: ${describeFailure(cause)}`,
    });
    return { inserted: 0, incomplete: true };
  }

  const { written, rejectedImplausible, reBaselined } = writePrices(
    db,
    instrumentId,
    source.id,
    points,
  );

  const earliestReturned = points.reduce<string | null>(
    (min, point) => (min === null || point.date < min ? point.date : min),
    null,
  );
  const gapDays =
    earliestReturned === null ? Number.POSITIVE_INFINITY : daysBetween(from, earliestReturned);
  const incomplete = points.length === 0 || gapDays > BACKFILL_GAP_TOLERANCE_DAYS;

  const parts = [`${written} hintapistettä tallennettu`];
  if (reBaselined > 0) {
    // Loud on purpose -- see the matching branch in refreshPrices above.
    console.warn(
      `Hintasarja uudelleenperustettu taustatäytössä: ${source.id} instrumentille ${instrumentId}`,
    );
    parts.push(`näistä ${reBaselined} UUDELLEENPERUSTETTU vahvistetun pysyvän muutoksen jälkeen`);
  }
  if (rejectedImplausible > 0) {
    parts.push(`${rejectedImplausible} hylätty epäuskottavana hintahyppynä`);
  }
  if (incomplete) {
    const coverage =
      earliestReturned === null
        ? "ei yhtään pistettä"
        : `varhaisin saatu piste ${earliestReturned}`;
    const knownReason =
      instrument.priceSource === "nordnet_fund"
        ? " -- nordnet_fund tarjoaa julkisesti vain kaksi tuoreinta NAV-arvoa, ei historiaa " +
          "(katso funds.ts:n NORDNET_FUND-kommentti); täydennä historia päivittäisellä " +
          "hintapäivityksellä ajan myötä"
        : "";
    parts.push(`taustatäyttö jäi vajaaksi: pyydetty alkaen ${from}, ${coverage}${knownReason}`);
  }

  // A re-baseline (see writePrices) takes priority over stray rejections:
  // the points that got folded into confirming it are an expected, safe
  // part of that process, not an unrelated failure -- mirrors the same
  // precedence refreshPrices gives it above.
  const ok = reBaselined > 0 ? !incomplete : !incomplete && rejectedImplausible === 0;

  logAttempt(db, { source: source.id, instrumentId, ok, message: parts.join("; ") });

  return { inserted: written, incomplete };
};

/**
 * `priceSource`s excluded from `needsBackfill`/`backfillMany` even though `backfillInstrument`
 * itself would happily attempt them: both genuinely cannot return history through their public,
 * unauthenticated page, no matter how many times they're asked. `nordnet_fund`'s page carries
 * only `latestNav`/`previousNav` -- two points (see funds.ts's `NORDNET_FUND` comment, and
 * `BackfillResult.incomplete`'s doc above). `op_fund`'s page carries exactly one NAV, the
 * current one (`OP_FUND`'s fetch returns at most a single `FetchedPrice`) -- the identical
 * shape of limitation, discovered while wiring this sweep up, not something `op_fund`'s own
 * source code claims anywhere in a comment. Neither will ever stop looking "incomplete" no
 * matter how many times a nightly catch-up sweep re-fetches it, so excluding them here is what
 * keeps that sweep from burning a request against each one, forever, for zero gain -- exactly
 * the "do not retry it pointlessly on every trigger" a real fix for this gap has to avoid.
 * `backfillInstrument` called directly (the import-commit trigger's one-off attempt, or a
 * manual `bun -e` call) is unaffected -- this exclusion only governs the sweep's own selection.
 */
const NEVER_BACKFILLABLE = new Set(["nordnet_fund", "op_fund"]);

/**
 * True when `instrumentId` has a real earliest transaction but its stored price history does
 * not yet reach it -- either no price row exists for it at all, or the earliest one is dated
 * more than `BACKFILL_GAP_TOLERANCE_DAYS` after that transaction. This is the selection this
 * task's nightly catch-up sweep (`backfillMany`, called from `runScheduledRefresh`) needs and
 * the existing daily `refreshPrices` sweep does not: `refreshPrices` always re-fetches
 * "today" for every instrument regardless of history, but re-running a full-range backfill
 * for an instrument that already has one would be a wasted request against Yahoo (or whichever
 * source) every single night, for an instrument that needs nothing further.
 */
const needsBackfill = (db: Db, instrumentId: number): boolean => {
  const instrument = db.select().from(instruments).where(eq(instruments.id, instrumentId)).get();
  if (!instrument) return false;
  if (instrument.priceSource === "manual" || NEVER_BACKFILLABLE.has(instrument.priceSource)) {
    return false;
  }

  const earliestTxn = db
    .select({ tradeDate: transactions.tradeDate })
    .from(transactions)
    .where(eq(transactions.instrumentId, instrumentId))
    .orderBy(asc(transactions.tradeDate))
    .limit(1)
    .get();
  if (!earliestTxn) return false;

  const earliestPrice = db
    .select({ date: prices.date })
    .from(prices)
    .where(eq(prices.instrumentId, instrumentId))
    .orderBy(asc(prices.date))
    .limit(1)
    .get();
  if (!earliestPrice) return true;

  return (
    earliestPrice.date > earliestTxn.tradeDate &&
    daysBetween(earliestPrice.date, earliestTxn.tradeDate) > BACKFILL_GAP_TOLERANCE_DAYS
  );
};

export type BackfillManyResult = {
  readonly attempted: number;
  readonly backfilled: number;
  readonly incomplete: number;
  readonly errored: number;
};

/**
 * Runs `backfillInstrument` for every id in `instrumentIds` that `needsBackfill` says actually
 * needs it, isolating each attempt from every other's exactly like `refreshPrices` does for the
 * daily fetch: `backfillInstrument` itself already catches and logs a source's own fetch
 * failure, but the surrounding `try/catch` here is a second, independent layer in case
 * something it did not anticipate (an unexpected database error, say) still throws -- this
 * function must never propagate a rejection, since both of its callers (the import-commit
 * route, and `runScheduledRefresh`'s nightly catch-up sweep below) rely on that to keep
 * backfill fully isolated from the operation that triggered it.
 *
 * Sequential, deliberately not concurrent: a handful of years-long histories fetched one at a
 * time is already gentle on a public endpoint like Yahoo's, and firing them all at once would
 * be exactly the unnecessary burst this task's own review called out as worth thinking about.
 * No further throttling (delays between requests, a request budget) is added on top of that --
 * this is a single-user instance backfilling at most a handful of instruments, not a fleet, and
 * inventing a rate limit with no evidence Yahoo's public endpoint actually needs one would be
 * exactly the kind of unverified guess this project's other `prices/` code already declines to
 * make (see `types.ts`'s `requirePositiveMinor` comment for the same principle applied to a
 * different check).
 */
export const backfillMany = async (
  db: Db,
  instrumentIds: readonly number[],
  opts: { fetchImpl?: FetchImpl; today?: string } = {},
): Promise<BackfillManyResult> => {
  let attempted = 0;
  let backfilled = 0;
  let incomplete = 0;
  let errored = 0;

  for (const instrumentId of new Set(instrumentIds)) {
    if (!needsBackfill(db, instrumentId)) continue;
    attempted++;
    try {
      const result = await backfillInstrument(db, instrumentId, opts);
      if (result.inserted > 0) backfilled++;
      if (result.incomplete) incomplete++;
    } catch (cause) {
      errored++;
      console.error(
        `Taustatäyttö epäonnistui odottamattomasti instrumentille ${instrumentId}`,
        cause,
      );
    }
  }

  return { attempted, backfilled, incomplete, errored };
};

/** Weekday evenings, after Finnish fund NAVs publish. */
const SCHEDULE = "30 19 * * 1-5";
const SCHEDULE_TZ = "Europe/Helsinki";

/**
 * The scheduled job's actual body, exported separately from
 * `startScheduler` so it can be called and asserted on directly in tests
 * without waiting on a real `Bun.cron` fire (the earliest this schedule
 * can trigger is the next weekday evening). `Bun.cron` mirrors
 * `setTimeout`'s error semantics: a handler that rejects with no
 * `unhandledRejection` listener on `process` takes the whole process
 * down. This function never lets a rejection escape -- `refreshFxRates`,
 * `refreshPrices`, `backfillFxRates` and the price backfill sweep below are each wrapped in
 * their own try/catch, so one evening's ECB outage or an unexpected database error cannot
 * stop the next evening's run. `src/server/index.ts` additionally registers a
 * process-wide `unhandledRejection` listener as a second, independent
 * layer of defense in case something here still escapes.
 */
export const runScheduledRefresh = async (db: Db): Promise<void> => {
  try {
    await refreshFxRates(db);
  } catch (cause) {
    console.error("FX-kurssien päivitys epäonnistui", cause);
  }
  try {
    const result = await refreshPrices(db);
    console.log(`Hintapäivitys: ${result.ok} onnistui, ${result.failed} epäonnistui`);
  } catch (cause) {
    console.error("Hintapäivitys epäonnistui", cause);
  }
  try {
    // Catches every held currency's fx_rates history up to the earliest date the ledger
    // actually needs it (see fx.ts's `backfillFxRates` -- the historical-file counterpart
    // to the daily fetch above). `needsFxBackfill`'s own check is what keeps this cheap on
    // every ordinary night once a currency's history has already been caught up once.
    const fxResult = await backfillFxRates(db);
    if (fxResult.currencies > 0) {
      console.log(
        `FX-historian täydennys: ${fxResult.inserted} kurssia lisätty ${fxResult.currencies} valuutalle`,
      );
    }
  } catch (cause) {
    console.error("FX-historian täydennys epäonnistui", cause);
  }
  try {
    // Catches up any instrument whose stored history still doesn't reach its earliest
    // transaction -- an instrument imported before this catch-up sweep existed, or one whose
    // one-off backfill on import (see src/server/import/backfill-on-commit.ts) failed or was
    // never triggered at all. `backfillMany`'s own `needsBackfill` filter is what keeps this
    // cheap on every ordinary night: an instrument already fully backfilled, `manual`, or a
    // source that can never complete one (`nordnet_fund`/`op_fund`) is skipped without a
    // network call.
    const allInstrumentIds = db
      .select({ id: instruments.id })
      .from(instruments)
      .all()
      .map((row) => row.id);
    const result = await backfillMany(db, allInstrumentIds);
    if (result.attempted > 0) {
      console.log(
        `Taustatäyttö: ${result.backfilled} täydentyi, ${result.incomplete} jäi vajaaksi, ` +
          `${result.errored} virheellistä (${result.attempted} instrumenttia yritetty)`,
      );
    }
  } catch (cause) {
    console.error("Taustatäyttö epäonnistui", cause);
  }
};

/**
 * Registers the in-process daily refresh job. `schedule`/`tz` default to
 * the real weekday-evening Helsinki schedule; overridable only so a test
 * can exercise the validation below against a deliberately invalid
 * expression without touching the production constants.
 *
 * `Bun.cron.parse` -- the exact parser `Bun.cron` itself uses -- is
 * called up front so a typo fails loudly, with a clear message, at
 * startup rather than at the job's first (much later) scheduled fire.
 * Verified directly (`bun -e`) that this parser actually rejects a bad
 * expression two different ways, both normalized into the one thrown
 * error below: it throws synchronously for a *syntactically* invalid
 * expression (e.g. "not a cron expression"), and it returns `null` --
 * without throwing -- for a syntactically valid one with no future
 * occurrence at all (e.g. "0 0 30 2 *", February 30th never occurs).
 */
export const startScheduler = (db: Db, opts: { schedule?: string; tz?: string } = {}): CronJob => {
  const schedule = opts.schedule ?? SCHEDULE;
  const tz = opts.tz ?? SCHEDULE_TZ;

  let nextFireTime: Date | null;
  try {
    nextFireTime = Bun.cron.parse(schedule, undefined, { tz });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "tuntematon virhe";
    throw new Error(`Ajastuslauseke ei kelpaa (${schedule}): ${detail}`);
  }
  if (nextFireTime === null) {
    throw new Error(`Ajastuslauseke ei kelpaa: sillä ei ole tulevaa ajankohtaa (${schedule})`);
  }

  return Bun.cron(schedule, () => runScheduledRefresh(db), { tz });
};
