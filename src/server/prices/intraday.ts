import { isNotNull } from "drizzle-orm";

import { positionsAt, type UnitTxn } from "../../core/ledger.ts";
import type { Db } from "../db/index.ts";
import { instruments, transactions } from "../db/schema.ts";
import { isOpen } from "./market-hours.ts";
import type { FetchImpl, FetchedPrice } from "./types.ts";
import { writePrices } from "./write.ts";
import { fetchLatestQuotes } from "./yahoo-batch.ts";
import { YahooPausedError, gatedFetch, yahooPausedUntil } from "./yahoo-gate.ts";

const END_OF_TIME = "9999-12-31";

export const heldInstrumentIds = async (db: Db): Promise<Set<number>> => {
  const rows = await db
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      instrumentId: transactions.instrumentId,
      type: transactions.type,
      tradeDate: transactions.tradeDate,
      quantity: transactions.quantity,
    })
    .from(transactions)
    .where(isNotNull(transactions.instrumentId))
    .all();

  const byAccount = Map.groupBy(
    rows.map((row): UnitTxn & { readonly accountId: number } => ({
      ...row,
      quantity: { scaled: BigInt(row.quantity) },
    })),
    (txn) => txn.accountId,
  );
  return new Set(
    [...byAccount.values()].flatMap((txns) => [...positionsAt(txns, END_OF_TIME).keys()]),
  );
};

// Yahoo symbols per intraday run; with yahoo-batch.ts's spaced fallback, 25 keeps a run near a minute.
// ponytail: ceiling of 25 symbols per run; holdings past it get only the evening close
const MAX_SYMBOLS_PER_RUN = 25;

type IntradayResult = {
  readonly asked: number;
  readonly written: number;
  readonly paused: boolean;
};

/** Latest quote for every held Yahoo listing whose exchange is open at `at`, stored under the quote's own date so later runs overwrite it. Funds wait for the evening run. */
export const refreshIntraday = async (
  db: Db,
  at: Date,
  fetchImpl: FetchImpl = fetch,
  spacingMs?: number,
): Promise<IntradayResult> => {
  const now = (): number => at.getTime();
  if ((await yahooPausedUntil(db, now)) !== null) return { asked: 0, written: 0, paused: true };

  const held = await heldInstrumentIds(db);
  const open = (await db.select().from(instruments).all()).filter(
    (row) => row.priceSource === "yahoo" && held.has(row.id) && isOpen(row.sourceKey, at),
  );
  const symbols = [...new Set(open.map((row) => row.sourceKey))].slice(0, MAX_SYMBOLS_PER_RUN);
  if (symbols.length === 0) return { asked: 0, written: 0, paused: false };

  const { quotes, paused } = await latestQuotesUntilPaused(
    symbols,
    gatedFetch(db, fetchImpl, now),
    spacingMs,
  );

  let written = 0;
  for (const row of open) {
    const quote = quotes.get(row.sourceKey);
    if (quote === undefined) continue;
    written += (await writePrices(db, row.id, "yahoo", [quote], { plausibleOnly: true })).written;
  }
  return { asked: symbols.length, written, paused };
};

/** `fetchLatestQuotes`, keeping quotes found before a 429 pause (`stopWhen` sees each, so they survive the throw). */
export const latestQuotesUntilPaused = async (
  symbols: readonly string[],
  fetchImpl: FetchImpl,
  spacingMs?: number,
): Promise<{ quotes: ReadonlyMap<string, FetchedPrice>; paused: boolean }> => {
  const found = new Map<string, FetchedPrice>();
  try {
    await fetchLatestQuotes(symbols, fetchImpl, spacingMs, (symbol, price) => {
      found.set(symbol, price);
      return false;
    });
    return { quotes: found, paused: false };
  } catch (err) {
    if (!(err instanceof YahooPausedError)) throw err;
    console.warn(`Yahoo paused, the remaining prices wait until later: ${err.message}`);
    return { quotes: found, paused: true };
  }
};
