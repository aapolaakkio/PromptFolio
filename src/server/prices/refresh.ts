import { asc, eq } from "drizzle-orm";

import type { ChatClient } from "../chat/runner.ts";
import { createClient } from "../chat/runner.ts";
import type { Db } from "../db/index.ts";
import { instruments, prices, transactions } from "../db/schema.ts";
import { backfillFxRates, refreshFxRates } from "../fx.ts";
import { refreshPage, PAGE_SPACING_MS, type PageOutcome } from "./page.ts";
import { logAttempt, recordPoints, type Priced } from "./record.ts";
import { sourceFor } from "./registry.ts";
import { heldInstrumentIds, latestQuotesUntilPaused } from "./intraday.ts";
import type { FetchImpl, FetchedPrice } from "./types.ts";
import { writePrices } from "./write.ts";
import { YahooPausedError, gatedFetch } from "./yahoo-gate.ts";

const today = (): string => new Date().toISOString().slice(0, 10);

/** Renders a cause caught from a `PriceSource.fetch()` call as a log message. */
const describeFailure = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Tuntematon virhe";

/**
 * Every Yahoo listing's latest quote, asked through the gate. A pause stops
 * Yahoo for the rest of the run: what was found is kept, the rest waits for
 * the next run without a log row each.
 */
const refreshFromYahoo = async (
  db: Db,
  listed: readonly Priced[],
  opts: { readonly fetchImpl?: FetchImpl; readonly spacingMs?: number },
): Promise<{ ok: number; failed: number; paused: boolean }> => {
  if (listed.length === 0) return { ok: 0, failed: 0, paused: false };
  const symbols = [...new Set(listed.map((row) => row.sourceKey))];
  const { quotes, paused } = await latestQuotesUntilPaused(
    symbols,
    gatedFetch(db, opts.fetchImpl ?? fetch),
    opts.spacingMs,
  );

  let ok = 0;
  let failed = 0;
  for (const instrument of listed) {
    const quote = quotes.get(instrument.sourceKey);
    if (quote === undefined) {
      if (paused) continue;
      failed++;
      await logAttempt(db, {
        source: "yahoo",
        instrumentId: instrument.id,
        ok: false,
        message: `Yahoo ei palauttanut hintaa tunnukselle ${instrument.sourceKey}`,
      });
    } else if (await recordPoints(db, instrument, [quote])) {
      ok++;
    } else {
      failed++;
    }
  }
  return { ok, failed, paused };
};

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/** One page instrument's run; an unexpected throw is logged, not allowed to stop the rest. */
const refreshPageSafely = async (
  db: Db,
  instrument: typeof instruments.$inferSelect,
  opts: Parameters<typeof refreshPage>[2],
): Promise<PageOutcome> => {
  try {
    return await refreshPage(db, instrument, opts);
  } catch (cause) {
    try {
      await logAttempt(db, {
        source: "page",
        instrumentId: instrument.id,
        ok: false,
        message: describeFailure(cause),
      });
    } catch (logCause) {
      console.error("Sivun haun lokirivin kirjoitus epäonnistui", logCause);
    }
    return "failed";
  }
};

/**
 * Today's price for every held, non-manual instrument, each attempt isolated
 * from the rest and each logged. An instrument nobody holds is skipped, and so
 * is a manual one: a human owns its price, so no fetch was attempted.
 */
export const refreshPrices = async (
  db: Db,
  opts: {
    fetchImpl?: FetchImpl;
    today?: string;
    yahooSpacingMs?: number;
    client?: ChatClient | null;
    pageSpacingMs?: number;
  } = {},
): Promise<{ ok: number; failed: number; paused: boolean }> => {
  const asOf = opts.today ?? today();
  const held = await heldInstrumentIds(db);
  const priced = (await db.select().from(instruments).all()).filter(
    (row) => row.priceSource !== "manual" && held.has(row.id),
  );

  let ok = 0;
  let failed = 0;
  // Yahoo first: a page that misbehaves must not cost the listed prices.
  const yahoo = await refreshFromYahoo(
    db,
    priced.filter((row) => row.priceSource === "yahoo"),
    { fetchImpl: opts.fetchImpl, spacingMs: opts.yahooSpacingMs },
  );
  const spacingMs = opts.pageSpacingMs ?? PAGE_SPACING_MS;
  let pagesFetched = 0;
  for (const instrument of priced.filter((row) => row.priceSource === "page")) {
    if (pagesFetched > 0) await sleep(spacingMs);
    pagesFetched++;
    const outcome = await refreshPageSafely(db, instrument, {
      fetchImpl: opts.fetchImpl ?? fetch,
      client: opts.client ?? null,
      today: asOf,
      now: Date.now(),
    });
    if (outcome === "ok") ok++;
    else failed++;
  }
  return { ok: ok + yahoo.ok, failed: failed + yahoo.failed, paused: yahoo.paused };
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

/**
 * Fetches history back to the instrument's earliest transaction and writes it.
 * A Yahoo instrument asks through the gate, and a pause is thrown as
 * `YahooPausedError` with nothing logged.
 */
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
  // A page needs refreshPage's model client; no history can be read from one.
  if (!instrument || instrument.priceSource === "manual" || instrument.priceSource === "page") {
    return { inserted: 0, incomplete: false };
  }

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

  const fetchImpl =
    instrument.priceSource === "yahoo" ? gatedFetch(db, opts.fetchImpl ?? fetch) : opts.fetchImpl;
  let points: FetchedPrice[];
  try {
    points = await source.fetch({ sourceKey: instrument.sourceKey, from, to, fetchImpl });
  } catch (cause) {
    // Not a failure of this instrument: Yahoo asked us to wait, and the caller
    // decides what that means for the rest of its run.
    if (cause instanceof YahooPausedError) throw cause;
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
    parts.push(`taustatäyttö jäi vajaaksi: pyydetty alkaen ${from}, ${coverage}`);
  }

  // A re-baseline outranks stray rejections: the points confirming it are part
  // of the process, not an unrelated failure.
  const ok = reBaselined > 0 ? !incomplete : !incomplete && rejectedImplausible === 0;

  await logAttempt(db, { source: source.id, instrumentId, ok, message: parts.join("; ") });

  return { inserted: written, incomplete };
};

/**
 * Sources whose page carries only the latest NAV and so can never complete a
 * backfill. They would look incomplete forever, and the nightly sweep would spend
 * a request on each one every night for nothing. Only the sweep's
 * selection is affected; a direct call still attempts them.
 */
const NEVER_BACKFILLABLE = new Set(["page"]);

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

  let paused = false;

  for (const instrumentId of new Set(instrumentIds)) {
    if (!(await needsBackfill(db, instrumentId))) continue;
    try {
      const result = await backfillInstrument(db, instrumentId, opts);
      attempted++;
      if (result.inserted > 0) backfilled++;
      if (result.incomplete) incomplete++;
    } catch (cause) {
      // Every later Yahoo call is refused by the gate without a request, so
      // the rest of the run keeps going for the other sources. Still needing
      // backfill, the instrument is picked up by the evening sweep.
      if (cause instanceof YahooPausedError) {
        if (!paused) console.warn(`Taustatäyttö: ${cause.message}, Yahoo jää myöhemmäksi`);
        paused = true;
        continue;
      }
      attempted++;
      errored++;
      console.error(
        `Taustatäyttö epäonnistui odottamattomasti instrumentille ${instrumentId}`,
        cause,
      );
    }
  }

  return { attempted, backfilled, incomplete, errored };
};

/** The model client, or null when its key is missing: page recipes are then not re-asked. */
const clientOrNull = (): ChatClient | null => {
  try {
    return createClient();
  } catch {
    return null;
  }
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
    const result = await refreshPrices(db, { client: clientOrNull() });
    console.log(
      `Hintapäivitys: ${result.ok} onnistui, ${result.failed} epäonnistui` +
        (result.paused ? " (Yahoo tauolla)" : ""),
    );
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
