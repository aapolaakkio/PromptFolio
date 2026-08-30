import {
  addMoney,
  divMoney,
  money,
  subMoney,
  toEur,
  zeroMoney,
  EUR,
  type Money,
} from "../money.ts";
import type { IsoDate, Txn } from "../types.ts";
import { OST_DEPOSIT_CAP_EUR } from "./rates.ts";

/**
 * The account's value on a date, or the instrument with no price for it. A named
 * instrument rather than a null, because the owner can record a missing price
 * and cannot act on a blank.
 */
export type OstValuation =
  | {
      readonly ok: true;
      readonly valueEur: Money;
      /**
       * The oldest price the valuation leaned on, when one was carried forward.
       * Invisible in the figure and decisive in the result: a single recorded
       * price makes every later date compute, at months-old worth.
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
   * An earlier withdrawal could not be valued, so its split between profit and
   * returned capital is unknown -- and with it the deposits every later
   * withdrawal is measured against. Carrying on regardless reported 0,00 EUR
   * taxable for a withdrawal the broker had withheld tax on.
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
 * One pass serves both: the part of a withdrawal that is not profit reduces the
 * deposits, which are both the base for the next withdrawal's profit share and
 * the figure the lifetime cap is measured against. The profit share is
 * proportional -- profit over value, applied to what was withdrawn.
 */
/** How far apart a reservation and its refund may sit and still be one event. */
const RESERVATION_DAYS = 8;

const daysBetween = (from: IsoDate, to: IsoDate): number =>
  Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000,
  );

/**
 * What the broker calls a subscription's two legs. Matched on its own words
 * where the ledger has them: no amount-and-window guess is as sure, and a real
 * subscription paired with an unrelated deposit invents a tax event.
 */
const SUBSCRIPTION_COMMITMENT = /merkint(äsitoumus|ämaksu)/i;
const SUBSCRIPTION_REFUND = /palautus/i;

/**
 * Withdrawal and deposit pairs that cancel each other out.
 *
 * A subscription is booked as money leaving to pay for it and returning days
 * later, both as ordinary rows nothing marks as belonging together -- so a real
 * IPO produced a withdrawal that never left the owner's hands, inventing a
 * taxable event and removing deposits that still count against the cap.
 *
 * Matched on an exact amount within days, each row used once. Conservative on
 * purpose: a missed pair overstates tax, an invented one hides it.
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
    // When the broker said what the row was, believe it. The shape-based rule
    // below is for rows imported before that text was kept, and for exports
    // that carry none.
    const named = SUBSCRIPTION_COMMITMENT.test(withdrawal.note ?? "");
    const refund = deposits.find(
      (deposit) =>
        !paired.has(deposit.id) &&
        deposit.amount.minor === size &&
        // The refund follows the commitment; a deposit that came first is the
        // money being paid in, not paid back.
        deposit.tradeDate >= withdrawal.tradeDate &&
        daysBetween(withdrawal.tradeDate, deposit.tradeDate) <= RESERVATION_DAYS &&
        (!named || SUBSCRIPTION_REFUND.test(deposit.note ?? "")),
    );
    if (refund === undefined) continue;
    // A row the broker named something else is not a subscription leg, however
    // neatly it pairs: an ordinary withdrawal followed days later by an equal
    // deposit is two real events, and treating them as one hides a taxable
    // withdrawal. Only rows with no text at all fall back to the shape.
    const texted = withdrawal.note !== null || refund.note !== null;
    if (texted && !named) continue;
    paired.add(refund.id);
    paired.add(withdrawal.id);
  }

  return paired;
};

/**
 * Capital income tax withheld, by date. The broker books it as a fee row, which
 * the importer keeps as a fee so money leaving permanently without reaching the
 * investor does not read as a withdrawal they enjoyed. Every fee on such an
 * account is that tax -- which is why the figure is reported beside our own
 * rather than folded into it.
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
   * The value immediately before a transaction. Before, not on: valuing after the
   * withdrawal has left divides profit by a total it shrank, overstating the
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
