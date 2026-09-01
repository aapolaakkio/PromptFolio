import { asc, eq } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { instruments, priceFetchLog, prices, transactions } from "../db/schema.ts";
import { backfillFxRates, refreshFxRates } from "../fx.ts";
import { sourceFor } from "./registry.ts";
import type { FetchImpl, FetchedPrice } from "./types.ts";
import { MAX_PLAUSIBLE_RATIO, writePrices } from "./write.ts";

const today = (): string => new Date().toISOString().slice(0, 10);

const logAttempt = async (
  db: Db,
  args: {
    readonly source: string;
    readonly instrumentId: number;
    readonly ok: boolean;
    readonly message: string;
  },
): Promise<void> => {
  await db
    .insert(priceFetchLog)
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
const describeFailure = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Tuntematon virhe";

/**
 * Today's price for every non-manual instrument, each attempt isolated from the
 * rest and each logged. A manual instrument is skipped without a log row: a
 * human owns its price, so no fetch was attempted.
 *
 * A point the plausibility check refuses is reported as a failure, not folded
 * into a clean "ok" -- the fetch worked, the data was not trusted.
 */
export const refreshPrices = async (
  db: Db,
  opts: { fetchImpl?: FetchImpl; today?: string } = {},
): Promise<{ ok: number; failed: number }> => {
  const asOf = opts.today ?? today();
  let ok = 0;
  let failed = 0;

  for (const instrument of await db.select().from(instruments).all()) {
    if (instrument.priceSource === "manual") continue;
    const source = sourceFor(instrument.priceSource);

    try {
      const points = await source.fetch({
        sourceKey: instrument.sourceKey,
        from: asOf,
        to: asOf,
        fetchImpl: opts.fetchImpl,
      });
      const { written, rejectedImplausible, reBaselined } = await writePrices(
        db,
        instrument.id,
        source.id,
        points,
      );

      if (reBaselined > 0) {
        // Loud on purpose: an implausible price was just confirmed as a real
        // permanent change, which is worth a human's attention.
        const message =
          `${written} hintapistettä tallennettu, näistä ${reBaselined} ` +
          `UUDELLEENPERUSTETTU vahvistetun pysyvän muutoksen jälkeen` +
          (rejectedImplausible > 0 ? ` (${rejectedImplausible} yhä hylätty)` : "");
        console.warn(
          `Hintasarja uudelleenperustettu: ${source.id} instrumentille ${instrument.id}`,
        );
        await logAttempt(db, { source: source.id, instrumentId: instrument.id, ok: true, message });
        ok++;
      } else if (rejectedImplausible > 0) {
        failed++;
        await logAttempt(db, {
          source: source.id,
          instrumentId: instrument.id,
          ok: false,
          message:
            `${written} hintapistettä tallennettu, ${rejectedImplausible} hylätty ` +
            `epäuskottavana hintahyppynä (yli ${MAX_PLAUSIBLE_RATIO}x)`,
        });
      } else {
        ok++;
        await logAttempt(db, {
          source: source.id,
          instrumentId: instrument.id,
          ok: true,
          message: `${written} hintapistettä`,
        });
      }
    } catch (cause) {
      failed++;
      await logAttempt(db, {
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
 * How far a source's earliest point may sit past the requested start before the
 * gap means it could not cover the range. A week covers any holiday weekend
 * without needing a real trading calendar.
 */
const BACKFILL_GAP_TOLERANCE_DAYS = 7;

const daysBetween = (isoA: string, isoB: string): number =>
  Math.abs(Date.parse(`${isoA}T00:00:00Z`) - Date.parse(`${isoB}T00:00:00Z`)) / 86_400_000;

export type BackfillResult = {
  readonly inserted: number;
  /**
   * Whether the source failed to cover the requested range. A fund page carrying
   * two NAV points can never backfill years of history, and this is what keeps
   * that from looking like a complete backfill of two rows. Detected by
   * comparing dates, so it catches any source with the same limitation.
   */
  readonly incomplete: boolean;
};

/** Fetches history back to the instrument's earliest transaction and writes it. */
export const backfillInstrument = async (
  db: Db,
  instrumentId: number,
  opts: { fetchImpl?: FetchImpl; today?: string } = {},
): Promise<BackfillResult> => {
  const instrument = await db
    .select()
    .from(instruments)
    .where(eq(instruments.id, instrumentId))
    .get();
  if (!instrument || instrument.priceSource === "manual") return { inserted: 0, incomplete: false };

  const earliest = await db
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
    await logAttempt(db, {
      source: source.id,
      instrumentId,
      ok: false,
      message: `Taustatäyttö epäonnistui: ${describeFailure(cause)}`,
    });
    return { inserted: 0, incomplete: true };
  }

  const { written, rejectedImplausible, reBaselined } = await writePrices(
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

  // A re-baseline outranks stray rejections: the points confirming it are part
  // of the process, not an unrelated failure.
  const ok = reBaselined > 0 ? !incomplete : !incomplete && rejectedImplausible === 0;

  await logAttempt(db, { source: source.id, instrumentId, ok, message: parts.join("; ") });

  return { inserted: written, incomplete };
};

/**
 * Sources whose public page carries one or two NAV points and so can never
 * complete a backfill. They would look incomplete forever, and the nightly sweep
 * would spend a request on each one every night for nothing. Only the sweep's
 * selection is affected; a direct call still attempts them.
 */
const NEVER_BACKFILLABLE = new Set(["nordnet_fund", "op_fund"]);

/**
 * Whether an instrument's stored history still falls short of its earliest
 * transaction. Re-running a full backfill for one that already reaches back
 * would be a wasted request every night.
 */
const needsBackfill = async (db: Db, instrumentId: number): Promise<boolean> => {
  const instrument = await db
    .select()
    .from(instruments)
    .where(eq(instruments.id, instrumentId))
    .get();
  if (!instrument) return false;
  if (instrument.priceSource === "manual" || NEVER_BACKFILLABLE.has(instrument.priceSource)) {
    return false;
  }

  const earliestTxn = await db
    .select({ tradeDate: transactions.tradeDate })
    .from(transactions)
    .where(eq(transactions.instrumentId, instrumentId))
    .orderBy(asc(transactions.tradeDate))
    .limit(1)
    .get();
  if (!earliestTxn) return false;

  const earliestPrice = await db
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
 * Backfills every instrument that needs it, each attempt isolated. This must
 * never reject: both callers rely on that to keep backfill separate from
 * whatever triggered it.
 *
 * Sequential rather than concurrent -- a handful of histories one at a time is
 * already gentle on a public endpoint, and a rate limit invented with no
 * evidence one is needed would be a guess.
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
    if (!(await needsBackfill(db, instrumentId))) continue;
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

/**
 * The day's prices and rates, called by POST /api/cron/refresh.
 *
 * Each phase has its own try/catch, so one evening's ECB outage cannot stop the
 * rest of the run -- and the endpoint answers rather than failing.
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
    // Every held currency's history back to the earliest date the ledger needs.
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
    // Any instrument whose history still falls short: one imported before this
    // sweep existed, or whose backfill on import failed or never ran.
    const allInstrumentIds = (await db.select({ id: instruments.id }).from(instruments).all()).map(
      (row) => row.id,
    );
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
