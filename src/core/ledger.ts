import {
  addQuantity,
  isZeroQuantity,
  negateMoney,
  subQuantity,
  toEur,
  type Quantity,
} from "./money.ts";
import type { CashFlow, IsoDate, Txn } from "./types.ts";

/** Sign applied to unit count; `null` is not a unit movement. */
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

/** Fields a unit count needs. */
export type UnitTxn = Pick<Txn, "id" | "instrumentId" | "type" | "tradeDate" | "quantity">;

const byTradeDateThenId = (
  a: Pick<Txn, "id" | "tradeDate">,
  b: Pick<Txn, "id" | "tradeDate">,
): number => (a.tradeDate === b.tradeDate ? a.id - b.id : a.tradeDate < b.tradeDate ? -1 : 1);

/** Transactions on or before `on`, oldest first. */
export const upTo = <T extends Pick<Txn, "id" | "tradeDate">>(
  txns: readonly T[],
  on: IsoDate,
): T[] =>
  txns
    .filter((t) => t.tradeDate <= on)
    .slice()
    .sort(byTradeDateThenId);

export const positionsAt = (txns: readonly UnitTxn[], on: IsoDate): Map<number, Quantity> => {
  const positions = new Map<number, Quantity>();
  for (const t of upTo(txns, on)) {
    if (t.instrumentId === null) continue;
    if (t.type === "SPLIT") {
      // SPLIT's quantity is the resulting total, not a delta.
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

/** Instruments disposed of more than acquired by `on`; consumers skip them and say so, never price them. */
export const negativePositionIds = (txns: readonly Txn[], on: IsoDate): number[] =>
  [...positionsAt(txns, on)].filter(([, qty]) => qty.scaled < 0n).map(([id]) => id);

export const externalCashFlows = (txns: readonly Txn[]): CashFlow[] =>
  txns
    .filter((t) => t.type === "DEPOSIT" || t.type === "WITHDRAWAL")
    .slice()
    .sort(byTradeDateThenId)
    .map((t) => ({ date: t.tradeDate, amountEur: toEur(t.amount, t.fxRateEur) }));

/**
 * Buys and sales as flows into the invested portfolio, for `twr` only, never `xirr`: the value
 * series prices positions only. Transfers are left out (no amount), a known gap for a rare shape.
 */
export const investedCashFlows = (txns: readonly Txn[]): CashFlow[] =>
  txns
    .filter((t) => (t.type === "BUY" || t.type === "SELL") && t.instrumentId !== null)
    .slice()
    .sort(byTradeDateThenId)
    .map((t) => ({ date: t.tradeDate, amountEur: negateMoney(toEur(t.amount, t.fxRateEur)) }));

/** Accounts with purchases but no cash record (no DEPOSIT, WITHDRAWAL or opening balance); OP's web view is one. */
export const accountsMissingCashRecord = (txns: readonly Txn[]): number[] => {
  const withCash = new Set<number>();
  const withPurchases = new Set<number>();
  for (const t of txns) {
    if (t.type === "DEPOSIT" || t.type === "WITHDRAWAL" || t.type === "OPENING_BALANCE") {
      withCash.add(t.accountId);
    }
    if (t.type === "BUY" || t.type === "SELL") withPurchases.add(t.accountId);
  }
  return [...withPurchases].filter((id) => !withCash.has(id)).sort((a, b) => a - b);
};

/** XIRR flows per account: deposits/withdrawals where cash is recorded, else trades. Never mixed within one account (double count). */
export const fundingCashFlows = (txns: readonly Txn[]): CashFlow[] => {
  const fallback = new Set(accountsMissingCashRecord(txns));
  const relevant = txns.filter((t) =>
    fallback.has(t.accountId)
      ? (t.type === "BUY" || t.type === "SELL") && t.instrumentId !== null
      : t.type === "DEPOSIT" || t.type === "WITHDRAWAL",
  );
  return relevant
    .slice()
    .sort(byTradeDateThenId)
    .map((t) => ({
      date: t.tradeDate,
      amountEur:
        t.type === "BUY" || t.type === "SELL"
          ? negateMoney(toEur(t.amount, t.fxRateEur))
          : toEur(t.amount, t.fxRateEur),
    }));
};
