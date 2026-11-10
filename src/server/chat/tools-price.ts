import { and, between, eq } from "drizzle-orm";
import { z } from "zod";

import { formatMoney, money, parseCurrency } from "../../core/money.ts";
import { prices } from "../db/schema.ts";
import { YAHOO } from "../prices/yahoo.ts";
import { YahooPausedError, gatedFetch } from "../prices/yahoo-gate.ts";
import type { FetchImpl } from "../prices/types.ts";
import { assertNotFuture } from "../prices/manual.ts";
import { loadPortfolio, tradedPrices } from "../valuation.ts";
import { ownInstrument } from "./proposal-kit.ts";
import { type ChatTool, type Db, IsoDateSchema, today } from "./tool-types.ts";

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;
const MAX_CANDIDATES = 12;
const DAY_MS = 86_400_000;

const FindPrice = z
  .object({
    instrumentId: z.number().int().positive(),
    date: IsoDateSchema,
    windowDays: z.number().int().min(1).max(MAX_WINDOW_DAYS).optional(),
  })
  .strict();

type Candidate = { readonly source: string; readonly date: string; readonly price: string };

const dayNumber = (date: string): number => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
const distance = (a: string, b: string): number => Math.abs(dayNumber(a) - dayNumber(b));
const shift = (date: string, days: number): string =>
  new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);

const quote = (minor: number | bigint, currency: string): string =>
  `${formatMoney(money(BigInt(minor), parseCurrency(currency)))} ${currency}`;

const ownTrades = async (db: Db, userId: string, id: number): Promise<Candidate[]> => {
  const { txns } = await loadPortfolio(db, userId);
  return tradedPrices(txns, [])
    .filter((point) => point.instrumentId === id)
    .map((point) => ({
      source: "own trade",
      date: point.date,
      price: quote(point.close, point.currency),
    }));
};

const storedPrices = async (db: Db, id: number, from: string, to: string) =>
  (
    await db
      .select()
      .from(prices)
      .where(and(eq(prices.instrumentId, id), between(prices.date, from, to)))
      .all()
  ).map((row) => ({
    source: "stored price",
    date: row.date,
    price: quote(row.close, row.currency),
  }));

type Yahoo = { readonly candidates: Candidate[]; readonly note: string | null };

/** One call through the app's own gate, never retried: a pause or an error is a note, not a second try. */
const yahooCloses = async (
  db: Db,
  fetchImpl: FetchImpl,
  sourceKey: string,
  from: string,
  to: string,
): Promise<Yahoo> => {
  try {
    const points = await YAHOO.fetch({ sourceKey, from, to, fetchImpl: gatedFetch(db, fetchImpl) });
    if (points.length === 0) return { candidates: [], note: "no Yahoo history for this ticker" };
    const candidates = points.map((point) => ({
      source: "yahoo history",
      date: point.date,
      price: quote(point.closeMinor, point.currency),
    }));
    return { candidates, note: null };
  } catch (cause) {
    if (cause instanceof YahooPausedError) {
      return { candidates: [], note: "Yahoo is rate limited, try later" };
    }
    return { candidates: [], note: "Yahoo history could not be read" };
  }
};

const within = (list: readonly Candidate[], date: string, days: number) =>
  list.filter((item) => distance(item.date, date) <= days);

const emptyNote = (list: readonly Candidate[], label: string, date: string, days: number) =>
  list.length === 0 ? [`no ${label} within ${days} days of ${date}`] : [];

export const buildPriceTool = (db: Db, userId: string, fetchImpl: FetchImpl = fetch): ChatTool => ({
  name: "find_price",
  description:
    "Looks for a price of one instrument the owner holds near a date, in what the app already " +
    "has: the owner's own trades, stored prices and, for a Yahoo instrument, one Yahoo history " +
    "lookup. instrumentId comes from get_instruments, date is YYYY-MM-DD and not in the future, " +
    `windowDays is optional (default ${DEFAULT_WINDOW_DAYS}, at most ${MAX_WINDOW_DAYS}). ` +
    "Returns candidates nearest first, each with its source, and notes on what was empty. " +
    "Quote the source when you propose one; if nothing is found, ask the owner.",
  schema: FindPrice,
  run: async (input) => {
    const { instrumentId, date, windowDays = DEFAULT_WINDOW_DAYS } = FindPrice.parse(input);
    assertNotFuture(date);
    const instrument = await ownInstrument(db, userId, instrumentId);
    const from = shift(date, -windowDays);
    const to = shift(date, windowDays);
    const own = within(await ownTrades(db, userId, instrumentId), date, windowDays);
    const stored = await storedPrices(db, instrumentId, from, to);
    const yahoo =
      instrument.priceSource === "yahoo"
        ? await yahooCloses(db, fetchImpl, instrument.sourceKey, from, to > today() ? today() : to)
        : { candidates: [], note: null };
    const candidates = [...own, ...stored, ...yahoo.candidates]
      .toSorted(
        (a, b) => distance(a.date, date) - distance(b.date, date) || b.date.localeCompare(a.date),
      )
      .slice(0, MAX_CANDIDATES);
    const notes = [
      ...emptyNote(own, "own trade", date, windowDays),
      ...emptyNote(stored, "stored price", date, windowDays),
      ...(yahoo.note === null ? [] : [yahoo.note]),
    ];
    return { instrumentId, date, windowDays, candidates, notes };
  },
});
