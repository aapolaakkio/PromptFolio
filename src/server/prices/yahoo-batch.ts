import { YAHOO } from "./yahoo.ts";
import { YahooPausedError } from "./yahoo-gate.ts";
import type { FetchImpl, FetchedPrice } from "./types.ts";

/**
 * Latest close and currency for many symbols.
 *
 * Checked 2026-11-08 with one plain request to
 * `https://query1.finance.yahoo.com/v8/finance/spark?symbols=NOKIA.HE,KCR.HE&range=1d&interval=1d`:
 * Yahoo answered 429 "Edge: Too Many Requests". No workaround was tried, so the
 * batch endpoint is unconfirmed and this uses the per-symbol chart call instead,
 * one at a time with a pause between.
 *
 * `fetchImpl` is expected to be gated already; a `YahooPausedError` from it
 * propagates. Any other failure for a symbol leaves that symbol out.
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
): Promise<Map<string, FetchedPrice>> => {
  const quotes = new Map<string, FetchedPrice>();
  // ponytail: spaced single requests; batch if Yahoo offers one
  for (const [index, symbol] of symbols.entries()) {
    if (index > 0) await sleep(spacingMs);
    const latest = await latestOf(symbol, fetchImpl);
    if (latest !== null) quotes.set(symbol, latest);
  }
  return quotes;
};
