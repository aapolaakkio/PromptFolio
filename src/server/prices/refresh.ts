import { asc, eq } from "drizzle-orm";

import type { ChatClient } from "../chat/runner.ts";
import { createClient } from "../chat/runner.ts";
import type { Db } from "../db/index.ts";
import { instruments, prices, transactions } from "../db/schema.ts";
import { backfillFxRates, refreshFxRates } from "../fx.ts";
import { refreshCosts } from "../instruments/costs.ts";
import { withModelTimeout } from "../instruments/find-page.ts";
import { refreshPage, PAGE_SPACING_MS, type PageOutcome } from "./page.ts";
import { logAttempt, recordPoints, type Priced } from "./record.ts";
import { sourceFor } from "./registry.ts";
import { heldInstrumentIds, latestQuotesUntilPaused } from "./intraday.ts";
import type { FetchImpl, FetchedPrice } from "./types.ts";
import { writePrices } from "./write.ts";
import { YahooPausedError, gatedFetch } from "./yahoo-gate.ts";

const today = (): string => new Date().toISOString().slice(0, 10);

const describeFailure = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Unknown error";

// A Yahoo pause stops Yahoo for the rest of the run: what was found is kept, the rest waits, without a log row each.
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
        message: `Yahoo returned no price for ticker ${instrument.sourceKey}`,
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
      console.error("Writing the page-lookup log row failed", logCause);
    }
    return "failed";
  }
};

/** Today's price for every held, non-manual instrument (a human owns a manual price), each attempt isolated and logged. */
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

// A week covers any holiday weekend without a trading calendar.
const BACKFILL_GAP_TOLERANCE_DAYS = 7;

const daysBetween = (isoA: string, isoB: string): number =>
  Math.abs(Date.parse(`${isoA}T00:00:00Z`) - Date.parse(`${isoB}T00:00:00Z`)) / 86_400_000;

type BackfillResult = {
  readonly inserted: number;
  /** The source's earliest point sits too far past the requested start, e.g. a fund page with two NAV points. */
  readonly incomplete: boolean;
};

/** Backfills history to the earliest transaction. A Yahoo pause is thrown as `YahooPausedError`, nothing logged. */
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
    if (cause instanceof YahooPausedError) throw cause;
    await logAttempt(db, {
      source: source.id,
      instrumentId,
      ok: false,
      message: `Backfill failed: ${describeFailure(cause)}`,
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

  const parts = [`${written} price points saved`];
  if (reBaselined > 0) {
    console.warn(
      `Price series rebased during backfill: ${source.id} for instrument ${instrumentId}`,
    );
    parts.push(`${reBaselined} of them REBASED after a confirmed permanent change`);
  }
  if (rejectedImplausible > 0) {
    parts.push(`${rejectedImplausible} rejected as an implausible price jump`);
  }
  if (incomplete) {
    const coverage =
      earliestReturned === null ? "no points" : `earliest point received ${earliestReturned}`;
    parts.push(`backfill fell short: requested from ${from}, ${coverage}`);
  }

  // A re-baseline outranks stray rejections: its confirming points are part of it.
  const ok = reBaselined > 0 ? !incomplete : !incomplete && rejectedImplausible === 0;

  await logAttempt(db, { source: source.id, instrumentId, ok, message: parts.join("; ") });

  return { inserted: written, incomplete };
};

// Page sources carry only the latest NAV: they would look incomplete forever and cost the sweep a request each night. A direct call still tries them.
const NEVER_BACKFILLABLE = new Set(["page"]);

/** Stored history still falls short of the earliest transaction. */
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

type BackfillManyResult = {
  readonly attempted: number;
  readonly backfilled: number;
  readonly incomplete: number;
  readonly errored: number;
};

/** Backfills every instrument that needs it, one at a time. Must never reject: callers rely on it. */
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
      // The gate refuses later Yahoo calls without a request; the evening sweep retries.
      if (cause instanceof YahooPausedError) {
        if (!paused) console.warn(`Backfill: ${cause.message}, Yahoo waits until later`);
        paused = true;
        continue;
      }
      attempted++;
      errored++;
      console.error(`Backfill failed unexpectedly for instrument ${instrumentId}`, cause);
    }
  }

  return { attempted, backfilled, incomplete, errored };
};

const clientOrNull = (): ChatClient | null => {
  try {
    return createClient();
  } catch {
    return null;
  }
};

const timedClientOrNull = (): ChatClient | null => {
  const client = clientOrNull();
  return client === null ? null : withModelTimeout(client);
};

/** The day's prices and rates (POST /api/cron/refresh). Each phase has its own try/catch so one outage cannot stop the rest. */
export const runScheduledRefresh = async (db: Db): Promise<void> => {
  try {
    await refreshFxRates(db);
  } catch (cause) {
    console.error("FX rate refresh failed", cause);
  }
  try {
    const result = await refreshPrices(db, { client: clientOrNull() });
    console.log(
      `Price refresh: ${result.ok} succeeded, ${result.failed} failed` +
        (result.paused ? " (Yahoo paused)" : ""),
    );
  } catch (cause) {
    console.error("Price refresh failed", cause);
  }
  try {
    const fxResult = await backfillFxRates(db);
    if (fxResult.currencies > 0) {
      console.log(
        `FX history backfill: ${fxResult.inserted} rates added for ${fxResult.currencies} currencies`,
      );
    }
  } catch (cause) {
    console.error("FX history backfill failed", cause);
  }
  try {
    const allInstrumentIds = (await db.select({ id: instruments.id }).from(instruments).all()).map(
      (row) => row.id,
    );
    const result = await backfillMany(db, allInstrumentIds);
    if (result.attempted > 0) {
      console.log(
        `Backfill: ${result.backfilled} completed, ${result.incomplete} fell short, ` +
          `${result.errored} errored (${result.attempted} instruments attempted)`,
      );
    }
  } catch (cause) {
    console.error("Backfill failed", cause);
  }
  try {
    const costs = await refreshCosts(db, {
      client: timedClientOrNull(),
      fetchImpl: fetch,
      now: Date.now(),
    });
    if (costs.asked > 0)
      console.log(`Fund costs: ${costs.stored} of ${costs.asked} looked up saved`);
  } catch (cause) {
    console.error("Fund cost lookup failed", cause instanceof Error ? cause.name : "UnknownError");
  }
};
