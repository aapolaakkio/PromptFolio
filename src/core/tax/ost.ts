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
/** How far apart a reservation and its refund may sit and still be one event. */
const RESERVATION_DAYS = 8;

const daysBetween = (from: IsoDate, to: IsoDate): number =>
  Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000,
  );

/**
 * The transaction ids of withdrawal/deposit pairs that cancel each other out.
 *
 * A share subscription on an equity savings account is booked by the broker as
 * money leaving to pay for it and returning days later, with the allotment
 * itself recorded separately as the purchase. Both legs are ordinary
 * TALLETUS/NOSTO rows -- nothing in the export marks them as belonging to a
 * subscription -- so a real IPO produced a withdrawal of the full subscription
 * amount that never left the owner's hands.
 *
 * Counting that as a withdrawal is wrong twice: it invents a taxable event out
 * of money that stayed on the account, and it removes deposits that still
 * count against the lifetime cap.
 *
 * Matched structurally, the same way `spending/internal.ts` pairs transfers
 * between the owner's own accounts: an outflow and an inflow of exactly equal
 * size, within days, each used at most once. Deliberately conservative --
 * requiring an exact amount match means a genuine withdrawal followed by an
 * unrelated deposit of a different size is untouched, which is the direction
 * to err in: a missed pair overstates tax, an invented pair hides it.
 */
export const reservationPairIds = (txns: readonly Txn[]): ReadonlySet<number> => {
  const paired = new Set<number>();
  const deposits = txns
    .filter((t) => t.type === "DEPOSIT")
    .sort((a, b) =>
      a.tradeDate === b.tradeDate ? a.id - b.id : a.tradeDate < b.tradeDate ? -1 : 1,
    );

  for (const withdrawal of txns.filter((t) => t.type === "WITHDRAWAL")) {
    const size = withdrawal.amount.minor < 0n ? -withdrawal.amount.minor : withdrawal.amount.minor;
    const refund = deposits.find(
      (deposit) =>
        !paired.has(deposit.id) &&
        deposit.amount.minor === size &&
        // The refund follows the reservation; a deposit that came first is the
        // money being paid in, not paid back.
        deposit.tradeDate >= withdrawal.tradeDate &&
        daysBetween(withdrawal.tradeDate, deposit.tradeDate) <= RESERVATION_DAYS,
    );
    if (refund === undefined) continue;
    paired.add(refund.id);
    paired.add(withdrawal.id);
  }

  return paired;
};

export const ostReport = (args: {
  /** This account's transactions, every year -- earlier ones set up the state. */
  readonly txns: readonly Txn[];
  /**
   * The account's value immediately before the transaction `beforeTxnId`.
   *
   * Before, not on: a withdrawal reduces the account's cash, and valuing the
   * account after it has left would divide the profit by a total the
   * withdrawal itself shrank -- understating the value, and so overstating the
   * profit share of every euro taken out.
   */
  readonly valueAt: (on: IsoDate, beforeTxnId: number) => OstValuation;
  readonly from: IsoDate;
  readonly to: IsoDate;
}): OstReport => {
  const withdrawals: OstWithdrawal[] = [];
  let deposited = zeroMoney(EUR);
  let incomplete = false;

  const reserved = reservationPairIds(args.txns);
  const chronological = [...args.txns].sort((a, b) =>
    a.tradeDate === b.tradeDate ? a.id - b.id : a.tradeDate < b.tradeDate ? -1 : 1,
  );

  for (const t of chronological) {
    // Neither leg of a subscription's reservation is a real movement of the
    // owner's money: it left to pay for shares and came back.
    if (reserved.has(t.id)) continue;
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
    const valuation = args.valueAt(t.tradeDate, t.id);
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
