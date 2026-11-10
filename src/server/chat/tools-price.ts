import { and, between, eq } from "drizzle-orm";
import { z } from "zod";

import { formatMoney, money, parseCurrency } from "../../core/money.ts";
import { prices } from "../db/schema.ts";
import { YAHOO } from "../prices/yahoo.ts";
import { YahooPausedError, gatedFetch } from "../prices/yahoo-gate.ts";
import type { FetchImpl } from "../prices/types.ts";
import { assertNotFuture } from "../prices/manual.ts";
import { helsinkiToday } from "../summary/helsinki.ts";
import { loadPortfolio, tradedPrices } from "../valuation.ts";
import { instrumentIn } from "./proposal-kit.ts";
import { type ChatTool, type Db, IsoDateSchema } from "./tool-types.ts";
import type { TurnState } from "./turn-state.ts";

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

type Candidate = {
  readonly source: string;
  readonly date: string;
  readonly price: string;
  readonly note?: string;
};

type Txns = Awaited<ReturnType<typeof loadPortfolio>>["txns"];

const dayNumber = (date: string): number => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
const distance = (a: string, b: string): number => Math.abs(dayNumber(a) - dayNumber(b));
const shift = (date: string, days: number): string =>
  new Date((dayNumber(date) + days) * DAY_MS).toISOString().slice(0, 10);

const quote = (minor: number | bigint, currency: string): string =>
  `${formatMoney(money(BigInt(minor), parseCurrency(currency)))} ${currency}`;

const ownTrades = (txns: Txns, id: number): Candidate[] =>
  tradedPrices(txns, [])
    .filter((point) => point.instrumentId === id)
    .map((point) => ({
      source: "own trade",
      date: point.date,
      price: quote(point.close, point.currency),
    }));

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

type Lookup = {
  readonly id: number;
  readonly sourceKey: string;
  readonly currency: string;
  readonly from: string;
  readonly to: string;
};

const NO_YAHOO: Yahoo = { candidates: [], note: null };
const USED_UP: Yahoo = { candidates: [], note: "Yahoo lookups used up for this answer" };

const yahooCandidate =
  (holding: string) =>
  (point: {
    readonly date: string;
    readonly closeMinor: number;
    readonly currency: string;
  }): Candidate => {
    const candidate = {
      source: "yahoo history",
      date: point.date,
      price: quote(point.closeMinor, point.currency),
    };
    if (point.currency === holding) return candidate;
    const note = `in ${point.currency}; the holding is priced in ${holding}: convert before recording`;
    return { ...candidate, note };
  };

/** One call through the app's own gate, never retried: a pause or an error is a note, not a second try. */
const yahooCloses = async (db: Db, fetchImpl: FetchImpl, q: Lookup): Promise<Yahoo> => {
  try {
    const { sourceKey, from, to } = q;
    const points = await YAHOO.fetch({ sourceKey, from, to, fetchImpl: gatedFetch(db, fetchImpl) });
    if (points.length === 0) return { candidates: [], note: "no Yahoo history for this ticker" };
    return { candidates: points.map(yahooCandidate(q.currency)), note: null };
  } catch (cause) {
    if (cause instanceof YahooPausedError) {
      return { candidates: [], note: "Yahoo is rate limited, try later" };
    }
    return { candidates: [], note: "Yahoo history could not be read" };
  }
};

/** At most three Yahoo requests per answer, and a repeated one is answered from this answer's copy. */
const turnYahoo = (db: Db, fetchImpl: FetchImpl, turn: TurnState) => {
  let seen: ReadonlyMap<string, Yahoo> = new Map();
  return async (q: Lookup): Promise<Yahoo> => {
    const key = `${q.id}:${q.from}:${q.to}`;
    const cached = seen.get(key);
    if (cached !== undefined) return cached;
    if (!turn.claimYahooLookup()) return USED_UP;
    const found = await yahooCloses(db, fetchImpl, q);
    seen = new Map([...seen, [key, found]]);
    return found;
  };
};

const within = (list: readonly Candidate[], date: string, days: number) =>
  list.filter((item) => distance(item.date, date) <= days);

const emptyNote = (list: readonly Candidate[], label: string, date: string, days: number) =>
  list.length === 0 ? [`no ${label} within ${days} days of ${date}`] : [];

export const buildPriceTool = (
  db: Db,
  userId: string,
  turn: TurnState,
  fetchImpl: FetchImpl = fetch,
): ChatTool => {
  const yahoo = turnYahoo(db, fetchImpl, turn);
  return {
    name: "find_price",
    description:
      "Looks for a price of one instrument the owner holds near a date, in what the app already " +
      "has: the owner's own trades, stored prices and, for a Yahoo instrument, one Yahoo history " +
      "lookup (at most three per answer). instrumentId comes from get_instruments, date is " +
      "YYYY-MM-DD and not in the future, " +
      `windowDays is optional (default ${DEFAULT_WINDOW_DAYS}, at most ${MAX_WINDOW_DAYS}). ` +
      "Returns candidates nearest first, each with its source, and notes on what was empty. " +
      "Quote the source when you propose one; if nothing is found, ask the owner.",
    schema: FindPrice,
    run: async (input) => {
      const { instrumentId, date, windowDays = DEFAULT_WINDOW_DAYS } = FindPrice.parse(input);
      assertNotFuture(date);
      const portfolio = await loadPortfolio(db, userId);
      const instrument = instrumentIn(portfolio, instrumentId);
      const from = shift(date, -windowDays);
      const latest = helsinkiToday(new Date());
      const to = shift(date, windowDays) > latest ? latest : shift(date, windowDays);
      const own = within(ownTrades(portfolio.txns, instrumentId), date, windowDays);
      const stored = await storedPrices(db, instrumentId, from, to);
      const { sourceKey, currency } = instrument;
      const found =
        instrument.priceSource === "yahoo"
          ? await yahoo({ id: instrumentId, sourceKey, currency, from, to })
          : NO_YAHOO;
      const candidates = [...own, ...stored, ...found.candidates]
        .toSorted(
          (a, b) => distance(a.date, date) - distance(b.date, date) || b.date.localeCompare(a.date),
        )
        .slice(0, MAX_CANDIDATES);
      const notes = [
        ...emptyNote(own, "own trade", date, windowDays),
        ...emptyNote(stored, "stored price", date, windowDays),
        ...(found.note === null ? [] : [found.note]),
      ];
      return { instrumentId, date, windowDays, candidates, notes };
    },
  };
};
