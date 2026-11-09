import { YAHOO } from "./yahoo.ts";
import { YahooPausedError } from "./yahoo-gate.ts";
import type { FetchImpl, FetchedPrice } from "./types.ts";

/**
 * Latest close and currency for many symbols, one chart call at a time with a pause: the spark
 * batch endpoint answered 429 when tried (2026-11-08) and is unconfirmed. `fetchImpl` is expected
 * to be gated (`YahooPausedError` propagates). `stopWhen` ends probing early; other failures drop the symbol.
 */
const SPACING_MS = 2000;
const WINDOW_DAYS = 10;
const DAY_MS = 86_400_000;

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

const latestOf = async (symbol: string, fetchImpl: FetchImpl): Promise<FetchedPrice | null> => {
  const now = Date.now();
  try {
    const prices = await YAHOO.fetch({
      sourceKey: symbol,
      from: new Date(now - WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10),
      to: new Date(now).toISOString().slice(0, 10),
      fetchImpl,
    });
    return prices.at(-1) ?? null;
  } catch (err) {
    if (err instanceof YahooPausedError) throw err;
    return null;
  }
};

export const fetchLatestQuotes = async (
  symbols: readonly string[],
  fetchImpl: FetchImpl,
  spacingMs: number = SPACING_MS,
  stopWhen: (symbol: string, price: FetchedPrice) => boolean = () => false,
): Promise<Map<string, FetchedPrice>> => {
  const quotes = new Map<string, FetchedPrice>();
  // ponytail: spaced single requests; batch if Yahoo offers one
  for (const [index, symbol] of symbols.entries()) {
    if (index > 0) await sleep(spacingMs);
    const latest = await latestOf(symbol, fetchImpl);
    if (latest === null) continue;
    quotes.set(symbol, latest);
    if (stopWhen(symbol, latest)) break;
  }
  return quotes;
};
