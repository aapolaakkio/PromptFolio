import {
  addMoney,
  EUR,
  toEur,
  zeroMoney,
  type Currency,
  type FxRate,
  type Money,
} from "./money.ts";
import { accountsMissingCashRecord, upTo } from "./ledger.ts";
import { datesBetween } from "./returns.ts";
import type { IsoDate, TransactionType, Txn } from "./types.ts";

/**
 * Uninvested cash in one account, in one currency. Derived rather than stored: a
 * table would be a second copy of what the rows already say, free to drift.
 */
export type CashBalance = {
  readonly accountId: number;
  readonly currency: Currency;
  readonly amount: Money;
};

/** A balance converted to euros, or `null` when no fx rate is known for the day. */
export type ValuedCash = CashBalance & {
  readonly valueEur: Money | null;
  /**
   * Whether the money can be reached on the day being valued. Both a deposit and
   * a current account count toward what the portfolio is worth; only one answers
   * "what could I use today". Decided by the caller, which knows the accounts.
   */
  readonly locked?: boolean;
  /** When a locked balance comes free, if the account records it. */
  readonly availableFrom?: IsoDate | null;
};

/** The euro total of the balances that can actually be reached on the day. */
export const availableCashEur = (valued: readonly ValuedCash[]): Money =>
  valued.reduce(
    (sum, balance) =>
      balance.valueEur === null || balance.locked === true ? sum : addMoney(sum, balance.valueEur),
    zeroMoney(EUR),
  );

/** The euro total of the balances that are tied up on the day. */
export const lockedCashEur = (valued: readonly ValuedCash[]): Money =>
  valued.reduce(
    (sum, balance) =>
      balance.valueEur === null || balance.locked !== true ? sum : addMoney(sum, balance.valueEur),
    zeroMoney(EUR),
  );

const key = (accountId: number, currency: Currency): string => `${accountId} ${currency}`;

/**
 * The types whose amount is money that entered or left the account.
 *
 * An opening balance is in: it is what the account already held, which is what a
 * balance is made of. It stays out of the cash-flow definitions instead, being
 * nobody's contribution during the period.
 *
 * Transfers are out: their amount is the acquisition value riding across a swap,
 * not cash, and counting it charged a real portfolio for money that never left.
 */
const CASH_MOVING: ReadonlySet<TransactionType> = new Set([
  "OPENING_BALANCE",
  "BUY",
  "SELL",
  "DEPOSIT",
  "WITHDRAWAL",
  "DIVIDEND",
  "INTEREST",
  "FEE",
]);

/**
 * Cash held per account and currency on `on`.
 *
 * An account whose export never records the money that funded its purchases is
 * skipped: summing its rows yields the negative of everything ever bought, an
 * artefact rather than a debt. Filtered here, not per call site, because a caller
 * that forgot would show a five-figure negative as fact.
 *
 * Zero balances are dropped. A negative one in an account that does record cash
 * is kept: it is real, and hiding it would overstate the total.
 */
export const cashBalancesAt = (txns: readonly Txn[], on: IsoDate): CashBalance[] => {
  const unrecorded = new Set(accountsMissingCashRecord(txns));
  const totals = new Map<string, CashBalance>();
  for (const txn of upTo(txns, on)) {
    if (unrecorded.has(txn.accountId)) continue;
    if (!CASH_MOVING.has(txn.type)) continue;
    const id = key(txn.accountId, txn.currency);
    const existing = totals.get(id);
    totals.set(id, {
      accountId: txn.accountId,
      currency: txn.currency,
      amount: addMoney(existing?.amount ?? zeroMoney(txn.currency), txn.amount),
    });
  }
  return [...totals.values()]
    .filter((balance) => balance.amount.minor !== 0n)
    .sort((a, b) =>
      a.accountId === b.accountId
        ? a.currency.localeCompare(b.currency)
        : a.accountId - b.accountId,
    );
};

/**
 * Each balance in euros at `on`'s rate. An unknown rate gives null rather than a
 * drop or a zero, exactly as an unpriceable holding does: the caller decides how
 * to show it, but must not quietly understate the total.
 */
export const valueCash = (
  balances: readonly CashBalance[],
  fxOn: (currency: Currency, on: IsoDate) => FxRate | null,
  on: IsoDate,
): ValuedCash[] =>
  balances.map((balance) => {
    if (balance.currency === EUR) return { ...balance, valueEur: balance.amount };
    const rate = fxOn(balance.currency, on);
    return {
      ...balance,
      valueEur: rate === null ? null : toEur(balance.amount, rate, "half-up"),
    };
  });

/** The euro total of everything that could be valued. */
export const totalCashEur = (valued: readonly ValuedCash[]): Money =>
  valued.reduce(
    (sum, balance) => (balance.valueEur === null ? sum : addMoney(sum, balance.valueEur)),
    zeroMoney(EUR),
  );

/**
 * Cash in euros on every day from `from` to `to`, by the same rules as
 * `cashBalancesAt`, in one pass: each transaction is added once as the days
 * reach it, rather than every balance being summed again for every day of a
 * twenty-year ledger. A balance in a currency with no rate that day is left out
 * of that day, as `totalCashEur` leaves out an unvalued one.
 */
export const cashSeries = (
  txns: readonly Txn[],
  fxOn: (currency: Currency, on: IsoDate) => FxRate | null,
  from: IsoDate,
  to: IsoDate,
): { date: IsoDate; cashEur: Money }[] => {
  const unrecorded = new Set(accountsMissingCashRecord(txns));
  const moving = txns
    .filter((txn) => !unrecorded.has(txn.accountId) && CASH_MOVING.has(txn.type))
    .toSorted((a, b) => (a.tradeDate < b.tradeDate ? -1 : a.tradeDate > b.tradeDate ? 1 : 0));
  const byCurrency = new Map<Currency, Money>();
  let next = 0;
  return datesBetween(from, to).map((date) => {
    while (next < moving.length && (moving[next]?.tradeDate ?? "") <= date) {
      const txn = moving[next]!;
      byCurrency.set(
        txn.currency,
        addMoney(byCurrency.get(txn.currency) ?? zeroMoney(txn.currency), txn.amount),
      );
      next += 1;
    }
    let cashEur = zeroMoney(EUR);
    for (const [currency, amount] of byCurrency) {
      if (currency === EUR) {
        cashEur = addMoney(cashEur, amount);
        continue;
      }
      const rate = fxOn(currency, date);
      if (rate !== null) cashEur = addMoney(cashEur, toEur(amount, rate, "half-up"));
    }
    return { date, cashEur };
  });
};
