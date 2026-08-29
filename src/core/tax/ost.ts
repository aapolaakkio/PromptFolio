import { addMoney, divMoney, money, subMoney, toEur, zeroMoney, EUR, type Money } from "../money";
import type { IsoDate, Txn } from "../types";
import { OST_DEPOSIT_CAP_EUR } from "./rates";

/**
 * The account's fair market value on a date, or the instrument that has no
 * price for it.
 *
 * A failure is a named instrument rather than a null: the withdrawal's tax is
 * unknowable without the value, and the owner can act on "this holding has no
 * price on this date" -- they can record one -- in a way they cannot act on a
 * blank.
 */
export type OstValuation =
  | { readonly ok: true; readonly valueEur: Money }
  | { readonly ok: false; readonly instrumentId: number };

export type OstWithdrawalOutcome =
  | {
      readonly ok: true;
      readonly valueEur: Money;
      readonly profitEur: Money;
      readonly taxableEur: Money;
    }
  | { readonly ok: false; readonly instrumentId: number };

export type OstWithdrawal = {
  readonly withdrawnOn: IsoDate;
  readonly amountEur: Money;
  readonly outcome: OstWithdrawalOutcome;
};

export type OstReport = {
  readonly withdrawals: readonly OstWithdrawal[];
  /** Cash paid in, less the capital returned by withdrawals. */
  readonly depositedEur: Money;
  /** What may still be paid in under the 100 000 € cap. */
  readonly capRemainingEur: Money;
  /** True once a withdrawal could not be valued, so the figures above are behind. */
  readonly incomplete: boolean;
};

/**
 * An equity savings account's withdrawals and deposit room.
 *
 * One pass serves both, because vero.fi ties them together: "the part of
 * withdrawn funds that is not counted as profit reduces the total amount of
 * cash payments made to the account". That reduced total is both the base for
 * the next withdrawal's profit share and the figure the 100 000 € cap is
 * measured against, so computing them separately would let them disagree.
 *
 * The profit share of a withdrawal is proportional: profit over value, applied
 * to the amount withdrawn.
 */
export const ostReport = (args: {
  /** This account's transactions, every year -- earlier ones set up the state. */
  readonly txns: readonly Txn[];
  readonly valueAt: (on: IsoDate) => OstValuation;
  readonly from: IsoDate;
  readonly to: IsoDate;
}): OstReport => {
  const withdrawals: OstWithdrawal[] = [];
  let deposited = zeroMoney(EUR);
  let incomplete = false;

  const chronological = [...args.txns].sort((a, b) =>
    a.tradeDate === b.tradeDate ? a.id - b.id : a.tradeDate < b.tradeDate ? -1 : 1,
  );

  for (const t of chronological) {
    if (t.type === "DEPOSIT") {
      deposited = addMoney(deposited, toEur(t.amount, t.fxRateEur, "half-up"));
      continue;
    }
    if (t.type !== "WITHDRAWAL") continue;

    // A withdrawal's `amount` is negative (cash leaving); the tax rules talk
    // about the amount withdrawn, so it is carried positive here.
    const amountEur = toEur(
      t.amount.minor < 0n ? money(-t.amount.minor, t.amount.currency) : t.amount,
      t.fxRateEur,
      "half-up",
    );
    const valuation = args.valueAt(t.tradeDate);
    const inWindow = t.tradeDate >= args.from && t.tradeDate <= args.to;

    if (!valuation.ok) {
      // The split between profit and returned capital is unknown, so
      // `deposited` cannot be advanced either: everything after this point is
      // provisional, which `incomplete` says out loud.
      incomplete = true;
      if (inWindow) {
        withdrawals.push({
          withdrawnOn: t.tradeDate,
          amountEur,
          outcome: { ok: false, instrumentId: valuation.instrumentId },
        });
      }
      continue;
    }

    const { valueEur } = valuation;
    // An account worth no more than what was paid in has no profit to tax. A
    // loss is not netted here: on an OST it is deductible only in the year the
    // account is closed, so a negative "taxable" figure would be wrong twice.
    const rawProfit = subMoney(valueEur, deposited);
    const profitEur = rawProfit.minor > 0n ? rawProfit : zeroMoney(EUR);
    const taxableEur =
      valueEur.minor === 0n
        ? zeroMoney(EUR)
        : divMoney(money(profitEur.minor * amountEur.minor, EUR), valueEur.minor, "half-up");

    if (inWindow) {
      withdrawals.push({
        withdrawnOn: t.tradeDate,
        amountEur,
        outcome: { ok: true, valueEur, profitEur, taxableEur },
      });
    }

    const capitalReturned = subMoney(amountEur, taxableEur);
    const remaining = subMoney(deposited, capitalReturned);
    deposited = remaining.minor > 0n ? remaining : zeroMoney(EUR);
  }

  const capRemaining = subMoney(OST_DEPOSIT_CAP_EUR, deposited);
  return {
    withdrawals,
    depositedEur: deposited,
    capRemainingEur: capRemaining.minor > 0n ? capRemaining : zeroMoney(EUR),
    incomplete,
  };
};
