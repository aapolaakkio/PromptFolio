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
  | {
      readonly ok: true;
      readonly valueEur: Money;
      /**
       * The oldest price date the valuation actually leaned on, when some
       * holding had no price for the day itself and a carried-forward one was
       * used instead. Null when every price was dated the day.
       *
       * Carried because the difference is invisible in the figure and decisive
       * in the result: one recorded price is enough to make every later date
       * compute, silently valuing a share at what it was worth months earlier.
       * A figure resting on that must say so, exactly as a holding does.
       */
      readonly pricedFrom: IsoDate | null;
      /** Which holding's price was carried forward, for the screen to offer a fix. */
      readonly pricedFromInstrumentId: number | null;
    }
  | { readonly ok: false; readonly instrumentId: number };

export type OstWithdrawalOutcome =
  | {
      readonly ok: true;
      readonly valueEur: Money;
      readonly profitEur: Money;
      readonly taxableEur: Money;
      /** See `OstValuation.pricedFrom`. Null when nothing was carried forward. */
      readonly pricedFrom: IsoDate | null;
      readonly pricedFromInstrumentId: number | null;
    }
  /** No price for a holding on that day, so the account has no known value. */
  | {
      readonly ok: false;
      readonly reason: "no-price";
      readonly instrumentId: number;
    }
  /**
   * An earlier withdrawal could not be valued, so how much of it was profit and
   * how much was capital returned is unknown -- and with it the deposits every
   * later withdrawal is measured against.
   *
   * This is reported rather than computed anyway. Carrying on regardless is what
   * produced a 0,00 € taxable figure for a withdrawal the broker had actually
   * withheld tax on: the deposits were too high, so the account looked like it
   * held no profit. A wrong figure that looks certain is worse than a gap.
   */
  | {
      readonly ok: false;
      readonly reason: "earlier-withdrawal";
      readonly since: IsoDate;
    };

export type OstWithdrawal = {
  readonly withdrawnOn: IsoDate;
  /** What left the account, tax withheld included. */
  readonly amountEur: Money;
  /**
   * Capital income tax the broker withheld from this withdrawal, where the
   * ledger records it. Evidence, not an input: it is what our own figure can be
   * checked against, and a disagreement is the whole point of computing this
   * twice.
   */
  readonly withheldEur: Money;
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

/**
 * Capital income tax withheld, by date.
 *
 * On an equity savings account the broker books this as a fee row of its own
 * ("PÄÄOMATULOVERO OST"), which the importer maps to `FEE` -- deliberately, so
 * that money leaving permanently without reaching the investor does not read as
 * a withdrawal they enjoyed. Every `FEE` on such an account is that tax; no
 * other charge has been observed on one. If a broker ever books another kind of
 * fee here, it would be read as withholding, which is why the figure is
 * reported beside our own rather than silently folded into it.
 */
const withheldTaxByDate = (txns: readonly Txn[]): Map<IsoDate, Money> => {
  const byDate = new Map<IsoDate, Money>();
  for (const t of txns) {
    if (t.type !== "FEE") continue;
    const magnitude = t.amount.minor < 0n ? -t.amount.minor : t.amount.minor;
    byDate.set(
      t.tradeDate,
      addMoney(
        byDate.get(t.tradeDate) ?? zeroMoney(EUR),
        toEur(money(magnitude, t.amount.currency), t.fxRateEur, "half-up"),
      ),
    );
  }
  return byDate;
};

/** What was withdrawn on each date, net of tax -- the denominator for splitting it. */
const withdrawnTotalByDate = (
  txns: readonly Txn[],
  reserved: ReadonlySet<number>,
): Map<IsoDate, Money> => {
  const byDate = new Map<IsoDate, Money>();
  for (const t of txns) {
    if (t.type !== "WITHDRAWAL" || reserved.has(t.id)) continue;
    const magnitude = t.amount.minor < 0n ? -t.amount.minor : t.amount.minor;
    byDate.set(
      t.tradeDate,
      addMoney(
        byDate.get(t.tradeDate) ?? zeroMoney(EUR),
        toEur(money(magnitude, t.amount.currency), t.fxRateEur, "half-up"),
      ),
    );
  }
  return byDate;
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
  /** The first withdrawal whose value was unknown; everything after it is guesswork. */
  let blockedSince: IsoDate | null = null;

  const reserved = reservationPairIds(args.txns);
  const withheldByDate = withheldTaxByDate(args.txns);
  const withdrawnByDate = withdrawnTotalByDate(args.txns, reserved);
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
    const net = toEur(
      t.amount.minor < 0n ? money(-t.amount.minor, t.amount.currency) : t.amount,
      t.fxRateEur,
      "half-up",
    );
    // The broker withholds the capital income tax out of the withdrawal, and
    // books it as its own row. What was withdrawn is therefore what reached the
    // owner plus what was withheld from it -- apportioning only the net would
    // understate the taxable share of every withdrawal that was taxed. Where a
    // day has several withdrawal rows, the day's withholding is split between
    // them in proportion, so the parts sum to what actually left.
    const dayWithheld = withheldByDate.get(t.tradeDate) ?? zeroMoney(EUR);
    const dayWithdrawn = withdrawnByDate.get(t.tradeDate) ?? zeroMoney(EUR);
    const withheldEur =
      dayWithheld.minor === 0n || dayWithdrawn.minor === 0n
        ? zeroMoney(EUR)
        : divMoney(money(dayWithheld.minor * net.minor, EUR), dayWithdrawn.minor, "half-up");
    const amountEur = addMoney(net, withheldEur);

    const inWindow = t.tradeDate >= args.from && t.tradeDate <= args.to;

    // Once one withdrawal's split is unknown, the deposits are too high by an
    // unknown amount, and every later withdrawal measured against them reads as
    // less profitable than it was -- as zero, in the case that exposed this.
    if (blockedSince !== null) {
      if (inWindow) {
        withdrawals.push({
          withdrawnOn: t.tradeDate,
          amountEur,
          withheldEur,
          outcome: {
            ok: false,
            reason: "earlier-withdrawal",
            since: blockedSince,
          },
        });
      }
      continue;
    }

    const valuation = args.valueAt(t.tradeDate, t.id);

    if (!valuation.ok) {
      // The split between profit and returned capital is unknown, so
      // `deposited` cannot be advanced either: everything after this point is
      // provisional, which `incomplete` says out loud.
      incomplete = true;
      blockedSince = t.tradeDate;
      if (inWindow) {
        withdrawals.push({
          withdrawnOn: t.tradeDate,
          amountEur,
          withheldEur,
          outcome: {
            ok: false,
            reason: "no-price",
            instrumentId: valuation.instrumentId,
          },
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
        withheldEur,
        outcome: {
          ok: true,
          valueEur,
          profitEur,
          taxableEur,
          pricedFrom: valuation.pricedFrom,
          pricedFromInstrumentId: valuation.pricedFromInstrumentId,
        },
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
