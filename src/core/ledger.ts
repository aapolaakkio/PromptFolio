import {
  addQuantity,
  isZeroQuantity,
  negateMoney,
  subQuantity,
  toEur,
  type Quantity,
} from "./money.ts";
import type { CashFlow, IsoDate, Txn } from "./types.ts";

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

/** The fields a unit count needs, so a caller without money values can count units too. */
export type UnitTxn = Pick<Txn, "id" | "instrumentId" | "type" | "tradeDate" | "quantity">;

const byTradeDateThenId = (
  a: Pick<Txn, "id" | "tradeDate">,
  b: Pick<Txn, "id" | "tradeDate">,
): number => (a.tradeDate === b.tradeDate ? a.id - b.id : a.tradeDate < b.tradeDate ? -1 : 1);

/** Every transaction dated on or before `on`, oldest first. Exported for core/cash.ts. */
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
 * Instruments disposed of more than acquired by `on`. The quantity stays negative
 * in the ledger, which is the honest state, but it must never be priced and
 * folded into a total, so every consumer skips it and says which it left out.
 *
 * The cost-basis side has its own richer signal carrying the offending date.
 */
export const negativePositionIds = (txns: readonly Txn[], on: IsoDate): number[] =>
  [...positionsAt(txns, on)].filter(([, qty]) => qty.scaled < 0n).map(([id]) => id);

export const externalCashFlows = (txns: readonly Txn[]): CashFlow[] =>
  txns
    .filter((t) => t.type === "DEPOSIT" || t.type === "WITHDRAWAL")
    .slice()
    .sort(byTradeDateThenId)
    .map((t) => ({ date: t.tradeDate, amountEur: toEur(t.amount, t.fxRateEur) }));

/**
 * Flows into and out of the invested portfolio, for `twr` alone and never `xirr`.
 *
 * The value series prices positions only, so the flow that changes what it prices
 * is a purchase or a sale. A deposit that has not been invested touches only the
 * cash account, which the series never looks at.
 *
 * Positive means into the measured thing, so a purchase's negative amount is
 * negated into an inflow and a sale's into an outflow.
 *
 * Transfers move quantities too but are left out: transferred in kind they carry
 * no amount to size a flow with. A transfer inside the window therefore causes
 * the mismatch `twr` warns about -- a known gap, for a rare shape.
 */
export const investedCashFlows = (txns: readonly Txn[]): CashFlow[] =>
  txns
    .filter((t) => (t.type === "BUY" || t.type === "SELL") && t.instrumentId !== null)
    .slice()
    .sort(byTradeDateThenId)
    .map((t) => ({ date: t.tradeDate, amountEur: negateMoney(toEur(t.amount, t.fxRateEur)) }));

/**
 * Accounts holding purchases but no cash record of any kind: no DEPOSIT, no
 * WITHDRAWAL, ever. OP's web transaction view is one -- it lists securities
 * transactions only, so the money that funded them never appears, and a
 * money-weighted return computed from deposits alone measures a portfolio
 * against a fraction of what was actually put into it.
 */
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

/**
 * What a money-weighted return is measured against, chosen per account from
 * whichever record it keeps.
 *
 * A broker that reports cash gives better evidence: deposits see money sitting
 * uninvested, purchases cannot. One that reports none leaves a purchase as the
 * only evidence money arrived, and deposits alone made those holdings appear from
 * nowhere -- reporting a real portfolio at three times its true rate.
 *
 * Per account, not a blanket switch: mixing the two within one would count a
 * deposit and the purchase it funded twice.
 */
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
