import { addMoney, EUR, toEur, zeroMoney, type Currency, type FxRate, type Money } from "./money";
import { accountsMissingCashRecord, upTo } from "./ledger";
import type { IsoDate, TransactionType, Txn } from "./types";

/**
 * Uninvested cash sitting in one account, in one currency.
 *
 * Derived from the ledger rather than stored: every row already moves cash by
 * its own `amount` -- a deposit in, a purchase out, a dividend in -- so a
 * `cash_balances` table would be a second copy of the same fact, free to drift
 * from the transactions it summarises. The balance is whatever the rows say.
 */
export type CashBalance = {
  readonly accountId: number;
  readonly currency: Currency;
  readonly amount: Money;
};

/** A balance converted to euros, or `null` when no fx rate is known for the day. */
export type ValuedCash = CashBalance & { readonly valueEur: Money | null };

const key = (accountId: number, currency: Currency): string => `${accountId} ${currency}`;

/**
 * The types whose `amount` is money that actually entered or left the account.
 *
 * OPENING_BALANCE is included: it is the money the account already held when its
 * recorded history begins, which is exactly what a balance is made of. It stays
 * out of the cash-flow definitions in ledger.ts instead, since it is not a
 * contribution anyone made during the period being measured.
 *
 * TRANSFER_IN and TRANSFER_OUT are excluded because their `amount` is not cash:
 * on a share swap or a tender offer the incoming leg carries the acquisition
 * value the broker states, so the original cost rides across to the new
 * instrument (see import/map.ts's `acquisitionAmount` and costbasis.ts's
 * `carriedBasis`). Counting it as cash charged a real portfolio 42,60 EUR that
 * never left the account. SPLIT moves units only and carries no amount at all.
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
 * Accounts that keep no cash record at all are skipped entirely. OP's export is
 * one: it lists securities transactions and never the money that funded them,
 * so summing its rows yields the negative of everything ever bought -- an
 * artefact of the export, not a debt. `accountsMissingCashRecord` already
 * identifies those accounts for the money-weighted return, and the same
 * judgement applies here. Filtering inside this function rather than at each
 * call site is deliberate: a caller that forgot would show a five-figure
 * negative balance as fact.
 *
 * Zero balances are dropped: an account that once held SEK and spent all of it
 * is not holding anything a reader cares about. A negative balance in an
 * account that DOES record cash is kept -- that one is real (a debited account,
 * an import missing one deposit), and hiding it would overstate the total.
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
 * Values each balance in euros at `on`'s rate.
 *
 * A balance whose rate is unknown gets `valueEur: null` rather than being
 * dropped or counted as zero -- the same rule spec 7 applies to an unpriceable
 * holding. The caller decides how to show it; what it must not do is quietly
 * understate the total.
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
