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

/** Uninvested cash in one account and currency; derived from rows, never stored. */
type CashBalance = {
  readonly accountId: number;
  readonly currency: Currency;
  readonly amount: Money;
};

/** A balance converted to euros, or `null` when no fx rate is known for the day. */
export type ValuedCash = CashBalance & {
  readonly valueEur: Money | null;
  /** Not reachable on the day (e.g. a term deposit); counts toward worth but not "usable today". Set by the caller. */
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
 * Types whose amount is cash entering or leaving the account. OPENING_BALANCE is in (a balance is
 * built from it). Transfers are out: their amount is acquisition value, not cash.
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
 * Cash per account and currency on `on`. Accounts whose export never records funding cash are
 * skipped (their sum is minus everything bought). Zero balances are dropped; real negatives kept.
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

/** Balances in euros at `on`'s rate; an unknown rate gives null, never a silent drop or zero. */
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

/** Daily euro cash by the rules of `cashBalancesAt`, in one pass; a currency without a rate that day is left out. */
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
