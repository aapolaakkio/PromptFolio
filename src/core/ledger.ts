import {
  addMoney,
  addQuantity,
  isZeroQuantity,
  negateMoney,
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

/** Every transaction dated on or before `on`, oldest first. Exported for core/cash.ts. */
export const upTo = (txns: readonly Txn[], on: IsoDate): Txn[] =>
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

/**
 * Cash flows into and out of the *invested* portfolio -- for `returns.ts`'s `twr`
 * exclusively, never `xirr` (see that function's own note on why it stays on
 * `externalCashFlows` above).
 *
 * `valueSeries` (spec §7) prices positions only -- quantity x price x FX -- and
 * deliberately excludes uninvested cash. `twr` must be fed flows describing money
 * moving into and out of that same, positions-only thing, or its sub-period bases
 * and its value series are quietly describing two different portfolios (see the
 * long comment on `twr` in `returns.ts` for the mismatch this replaced and why a
 * deposit is the wrong flow to use). The flow that actually changes what
 * `valueSeries` prices is a BUY (units acquired) or a SELL (units disposed of) --
 * a DEPOSIT that has not yet been invested changes only the cash account, which
 * `valueSeries` does not look at, so it is not a flow into the measured portfolio
 * at all.
 *
 * Sign mirrors `externalCashFlows`'s "positive = flowed into the measured thing"
 * convention: a BUY's `amount` is negative (cash left the account to fund it), so
 * it is negated here into a positive inflow to positions; a SELL's `amount` is
 * positive (cash credited on disposal), negated into a negative outflow.
 *
 * TRANSFER_IN/TRANSFER_OUT also move `positionsAt`'s quantities (see
 * `unitDirection` above) but are deliberately left out here: a security
 * transferred in kind carries no `amount` (no cash moved) to size the flow with,
 * so including it would need a priced valuation of the transferred lot that this
 * ledger does not have. A transfer during the measured window therefore still
 * causes the exact same base/value mismatch `twr`'s doc warns about, just for a
 * rarer transaction type than every ledger's ordinary deposit-then-buy shape --
 * a known, undocumented-until-now gap, not a silent one repeated here.
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
    if (t.type === "DEPOSIT" || t.type === "WITHDRAWAL") withCash.add(t.accountId);
    if (t.type === "BUY" || t.type === "SELL") withPurchases.add(t.accountId);
  }
  return [...withPurchases].filter((id) => !withCash.has(id)).sort((a, b) => a - b);
};

/**
 * The contributions and withdrawals a money-weighted return should be measured
 * against, chosen per account from whichever record that account actually keeps.
 *
 * Where a broker reports cash (Nordnet), its deposits and withdrawals are the
 * better evidence: they capture money sitting uninvested, which purchases cannot
 * see. Where it reports none (OP), a purchase is unambiguous evidence that money
 * arrived from outside, whether or not a deposit line was ever printed -- and
 * using deposits alone there would treat those holdings as having appeared from
 * nowhere. Measured against recorded deposits alone, a real portfolio reported a
 * money-weighted return roughly three times the truth; against the money actually
 * put to work, it came out where it should.
 *
 * Deliberately per account rather than a blanket switch to purchases: mixing the
 * two definitions across one account would double-count a deposit and the buy it
 * funded.
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
