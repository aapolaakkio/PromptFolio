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
import { daysBetween } from "../staleness.ts";
import type { IsoDate, Txn } from "../types.ts";
import { OST_DEPOSIT_CAP_EUR } from "./rates.ts";

/** The account's value on a date, or the instrument lacking a price (the owner can record one). */
export type OstValuation =
  | {
      readonly ok: true;
      readonly valueEur: Money;
      /** Oldest carried-forward price used; one recorded price otherwise makes later dates compute at stale worth. */
      readonly pricedFrom: IsoDate | null;
      /** Which holding's price was carried forward, so the screen can offer a fix. */
      readonly pricedFromInstrumentId: number | null;
    }
  | { readonly ok: false; readonly instrumentId: number };

type OstWithdrawalOutcome =
  | {
      readonly ok: true;
      readonly valueEur: Money;
      readonly profitEur: Money;
      readonly taxableEur: Money;
      readonly pricedFrom: IsoDate | null;
      readonly pricedFromInstrumentId: number | null;
    }
  | {
      readonly ok: false;
      readonly reason: "no-price";
      readonly instrumentId: number;
    }
  // An earlier withdrawal is unvalued, so the deposits later ones are measured against are unknown.
  | {
      readonly ok: false;
      readonly reason: "earlier-withdrawal";
      readonly since: IsoDate;
    };

type OstWithdrawal = {
  readonly withdrawnOn: IsoDate;
  /** What left the account, tax withheld included. */
  readonly amountEur: Money;
  /** Tax the broker withheld, where recorded. Evidence to check our own figure against, not an input. */
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

/** How far apart a reservation and its refund may sit and still be one event. */
const RESERVATION_DAYS = 8;

// The broker's own words for a subscription's two legs (Finnish, parsed from notes); surer than amount matching.
const SUBSCRIPTION_COMMITMENT = /merkint(äsitoumus|ämaksu)/i;
const SUBSCRIPTION_REFUND = /palautus/i;

/**
 * Withdrawal/deposit pairs that cancel out (an IPO subscription paid and refunded days later).
 * Exact amount within days, each row once. Conservative: a missed pair overstates tax, an invented one hides it.
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
    // Believe the broker's text; the shape-based rule is for rows without any.
    const named = SUBSCRIPTION_COMMITMENT.test(withdrawal.note ?? "");
    const refund = deposits.find(
      (deposit) =>
        !paired.has(deposit.id) &&
        deposit.amount.minor === size &&
        // A deposit before the withdrawal is money paid in, not a refund.
        deposit.tradeDate >= withdrawal.tradeDate &&
        daysBetween(withdrawal.tradeDate, deposit.tradeDate) <= RESERVATION_DAYS &&
        (!named || SUBSCRIPTION_REFUND.test(deposit.note ?? "")),
    );
    if (refund === undefined) continue;
    // Rows the broker named otherwise are two real events, not a pair; only text-less rows use the shape.
    const texted = withdrawal.note !== null || refund.note !== null;
    if (texted && !named) continue;
    paired.add(refund.id);
    paired.add(withdrawal.id);
  }

  return paired;
};

/** Withheld capital income tax by date: every fee row on such an account is that tax. */
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

/** Withdrawn net of tax per date; the denominator for splitting withheld tax. */
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
  readonly txns: readonly Txn[];
  /** Value immediately before the transaction: after it, the shrunken total overstates the profit share. */
  readonly valueAt: (on: IsoDate, beforeTxnId: number) => OstValuation;
  readonly from: IsoDate;
  readonly to: IsoDate;
}): OstReport => {
  const withdrawals: OstWithdrawal[] = [];
  let deposited = zeroMoney(EUR);
  let incomplete = false;
  let blockedSince: IsoDate | null = null;

  const reserved = reservationPairIds(args.txns);
  const withheldByDate = withheldTaxByDate(args.txns);
  const withdrawnByDate = withdrawnTotalByDate(args.txns, reserved);
  const chronological = [...args.txns].sort((a, b) =>
    a.tradeDate === b.tradeDate ? a.id - b.id : a.tradeDate < b.tradeDate ? -1 : 1,
  );

  for (const t of chronological) {
    if (reserved.has(t.id)) continue;
    if (t.type === "DEPOSIT") {
      deposited = addMoney(deposited, toEur(t.amount, t.fxRateEur, "half-up"));
      continue;
    }
    if (t.type !== "WITHDRAWAL") continue;

    // `amount` is negative (cash leaving); carried positive here.
    const net = toEur(
      t.amount.minor < 0n ? money(-t.amount.minor, t.amount.currency) : t.amount,
      t.fxRateEur,
      "half-up",
    );
    // Withdrawn = net received + tax withheld (its own row); a day's withholding is split pro rata across its withdrawals.
    const dayWithheld = withheldByDate.get(t.tradeDate) ?? zeroMoney(EUR);
    const dayWithdrawn = withdrawnByDate.get(t.tradeDate) ?? zeroMoney(EUR);
    const withheldEur =
      dayWithheld.minor === 0n || dayWithdrawn.minor === 0n
        ? zeroMoney(EUR)
        : divMoney(money(dayWithheld.minor * net.minor, EUR), dayWithdrawn.minor, "half-up");
    const amountEur = addMoney(net, withheldEur);

    const inWindow = t.tradeDate >= args.from && t.tradeDate <= args.to;

    // After an unvalued withdrawal, deposits are too high and later profits read too low.
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
      // Split unknown, so `deposited` cannot advance; the rest is provisional.
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
    // No profit at or below deposits. A loss is deductible only when the OST is closed, so never negative here.
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
