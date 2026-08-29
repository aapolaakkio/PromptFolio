import { addMoney, money, negateMoney, zeroMoney, EUR, type Money } from "../money";
import type { DriftRow } from "./drift";

/**
 * The smallest trade worth making, in minor units: 50,00 €.
 *
 * Every broker charges a minimum commission, so a 3 € trade to correct two
 * tenths of a point costs more than the drift it corrects. Trades below this
 * are dropped from the plan -- and listed, because the owner may have a reason
 * to make one anyway.
 */
export const MIN_TRADE_MINOR = 5_000n;

export type Trade = {
  readonly key: string;
  readonly label: string;
  readonly side: "buy" | "sell";
  /** Always positive: the side says which way the money goes. */
  readonly amountEur: Money;
  /** For a sale, the gain FIFO would realise. Null when the cost basis is unknown. */
  readonly realisedGainEur: Money | null;
  readonly gainUnknown: boolean;
};

export type RebalancePlan = {
  readonly trades: readonly Trade[];
  /** Dropped for being below the floor. Listed, never hidden. */
  readonly tooSmall: readonly Trade[];
  readonly totalRealisedGainEur: Money;
  /** True when any sale's gain could not be computed, so the total is short. */
  readonly gainIncomplete: boolean;
  /** True when the remaining buys and sells fund each other exactly. */
  readonly balanced: boolean;
};

/**
 * The buys and sells that put every slice on target, and what each sale costs.
 *
 * Every sale carries the gain it would realise. This is the point of the whole
 * view: a tool that says "sell 4 000 € of X" without saying that this realises
 * a gain is not neutral advice, it is quietly recommending a taxable event. The
 * figure is a gain and never a tax -- what tax it attracts depends on the
 * owner's other capital income, which nothing here can see.
 *
 * `gainOnSale` is injected because a slice-level sale does not name an
 * instrument: "sell 1 000 € of funds" has no FIFO gain until a caller decides
 * which fund. `core` stays free of that decision and of the lot machinery's
 * wiring.
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

/**
 * How a slice-level sale is attributed to the instruments inside it: largest
 * holding first, so the fewest positions are disturbed.
 *
 * Exported for the server layer, which knows what a slice holds. Returns the
 * amount to sell of each instrument, summing to `amountEur`.
 */
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
