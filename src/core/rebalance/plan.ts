import { addMoney, money, negateMoney, zeroMoney, EUR, type Money } from "../money.ts";
import type { DriftRow } from "./drift.ts";

/** Smallest worthwhile trade, 50,00 €: minimum commissions outweigh smaller drift. Smaller ones are listed, not hidden. */
const MIN_TRADE_MINOR = 5_000n;

export type Trade = {
  readonly key: string;
  readonly label: string;
  readonly side: "buy" | "sell";
  readonly amountEur: Money;
  /** For a sale, the FIFO gain it realises; null when the cost basis is unknown. */
  readonly realisedGainEur: Money | null;
  readonly gainUnknown: boolean;
};

type RebalancePlan = {
  readonly trades: readonly Trade[];
  /** Below the floor. */
  readonly tooSmall: readonly Trade[];
  readonly totalRealisedGainEur: Money;
  readonly gainIncomplete: boolean;
  readonly balanced: boolean;
};

/**
 * Buys and sells that put every slice on target. Each sale carries the gain it realises (a gain,
 * never a tax: that depends on income unseen here). `gainOnSale` is injected because a slice-level
 * sale names no instrument until the caller picks one.
 */
export const rebalancePlan = (args: {
  readonly rows: readonly DriftRow[];
  readonly gainOnSale: (key: string, amountEur: Money) => Money | null;
  readonly minTradeMinor?: bigint;
}): RebalancePlan => {
  const { rows, gainOnSale, minTradeMinor = MIN_TRADE_MINOR } = args;
  const all: Trade[] = [];

  for (const row of rows) {
    if (row.untargeted || row.driftEur === null || row.driftEur.minor === 0n) continue;
    const buying = row.driftEur.minor > 0n;
    const amountEur = buying ? row.driftEur : negateMoney(row.driftEur);
    const gain = buying ? null : gainOnSale(row.key, amountEur);
    all.push({
      key: row.key,
      label: row.label,
      side: buying ? "buy" : "sell",
      amountEur,
      realisedGainEur: gain,
      gainUnknown: !buying && gain === null,
    });
  }

  const trades = all.filter((trade) => trade.amountEur.minor >= minTradeMinor);
  const tooSmall = all.filter((trade) => trade.amountEur.minor < minTradeMinor);

  const sideTotal = (side: Trade["side"]): Money =>
    trades
      .filter((trade) => trade.side === side)
      .reduce((sum, trade) => addMoney(sum, trade.amountEur), zeroMoney(EUR));

  return {
    trades,
    tooSmall,
    totalRealisedGainEur: trades.reduce(
      (sum, trade) => (trade.realisedGainEur === null ? sum : addMoney(sum, trade.realisedGainEur)),
      zeroMoney(EUR),
    ),
    gainIncomplete: trades.some((trade) => trade.gainUnknown),
    balanced: sideTotal("buy").minor === sideTotal("sell").minor,
  };
};

/** Splits a slice-level sale across its holdings, largest first (fewest positions disturbed). */
export const attributeSale = (
  holdings: readonly { readonly instrumentId: number; readonly valueEur: Money }[],
  amountEur: Money,
): readonly { readonly instrumentId: number; readonly amountEur: Money }[] => {
  const largestFirst = [...holdings].sort((a, b) => Number(b.valueEur.minor - a.valueEur.minor));
  const parts: { instrumentId: number; amountEur: Money }[] = [];
  let left = amountEur.minor;

  for (const holding of largestFirst) {
    if (left <= 0n) break;
    const take = holding.valueEur.minor < left ? holding.valueEur.minor : left;
    if (take <= 0n) continue;
    parts.push({ instrumentId: holding.instrumentId, amountEur: money(take, EUR) });
    left -= take;
  }
  return parts;
};
