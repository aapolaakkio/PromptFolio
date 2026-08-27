import {
  addMoney,
  addQuantity,
  isZeroQuantity,
  subQuantity,
  toEur,
  zeroMoney,
  type Currency,
  type Money,
  type Quantity,
} from "./money";
import type { CashFlow, IsoDate, Txn } from "./types";

/** Sign a transaction type applies to unit count. `null` means "not a unit movement". */
const unitDirection = (type: Txn["type"]): 1 | -1 | null => {
  switch (type) {
    case "BUY":
    case "TRANSFER_IN":
      return 1;
    case "SELL":
    case "TRANSFER_OUT":
      return -1;
    default:
      return null;
  }
};

const byTradeDateThenId = (a: Txn, b: Txn): number =>
  a.tradeDate === b.tradeDate ? a.id - b.id : a.tradeDate < b.tradeDate ? -1 : 1;

const upTo = (txns: readonly Txn[], on: IsoDate): Txn[] =>
  txns
    .filter((t) => t.tradeDate <= on)
    .slice()
    .sort(byTradeDateThenId);

export const positionsAt = (txns: readonly Txn[], on: IsoDate): Map<number, Quantity> => {
  const positions = new Map<number, Quantity>();
  for (const t of upTo(txns, on)) {
    if (t.instrumentId === null) continue;
    if (t.type === "SPLIT") {
      // SPLIT's quantity is the resulting total, not a delta — replace outright,
      // even if there was no prior position (e.g. the instrument is new to the ledger).
      positions.set(t.instrumentId, t.quantity);
      continue;
    }
    const direction = unitDirection(t.type);
    if (direction === null) continue;
    const current = positions.get(t.instrumentId) ?? { scaled: 0n };
    positions.set(
      t.instrumentId,
      direction === 1 ? addQuantity(current, t.quantity) : subQuantity(current, t.quantity),
    );
  }
  for (const [id, qty] of positions) if (isZeroQuantity(qty)) positions.delete(id);
  return positions;
};

/**
 * Instrument ids whose net position at `on` is negative -- the ledger has recorded
 * disposing of more units than it has recorded acquiring, for that instrument, by
 * that date. `positionsAt` above deliberately keeps a negative quantity as-is (it is
 * core ledger state, reported verbatim), but a negative quantity must never be
 * multiplied by a price and folded into a value or allocation total -- see
 * `allocation.ts`'s `allocateBy` and `returns.ts`'s `valueSeries`, which both skip
 * these instruments' contribution rather than let a negative amount silently drag a
 * total down, and `server/api/portfolio.ts`, which uses this list to tell the caller
 * which instruments were left out and why, instead of the anomaly just vanishing.
 *
 * (The matching cost-basis-side signal is `costbasis.ts`'s `UnmatchedDisposalError`,
 * which also carries the offending trade's date; `holdingsFor` in
 * `server/valuation.ts` uses that richer signal instead of this one, since a holdings
 * row can show a proper Finnish explanation per position.)
 */
export const negativePositionIds = (txns: readonly Txn[], on: IsoDate): number[] =>
  [...positionsAt(txns, on)].filter(([, qty]) => qty.scaled < 0n).map(([id]) => id);

export const cashAt = (txns: readonly Txn[], on: IsoDate, currency: Currency): Money =>
  upTo(txns, on)
    .filter((t) => t.currency === currency)
    .reduce((sum, t) => addMoney(sum, t.amount), zeroMoney(currency));

export const externalCashFlows = (txns: readonly Txn[]): CashFlow[] =>
  txns
    .filter((t) => t.type === "DEPOSIT" || t.type === "WITHDRAWAL")
    .slice()
    .sort(byTradeDateThenId)
    .map((t) => ({ date: t.tradeDate, amountEur: toEur(t.amount, t.fxRateEur) }));
