import { addMoney, money, toEur, zeroMoney, EUR, type Money } from "../money.ts";
import type { Txn } from "../types.ts";

type FeeYear = {
  readonly year: number;
  readonly tradeFeesEur: Money;
  /** Broker charges: savings-plan service fee, custody. */
  readonly chargedFeesEur: Money;
  readonly totalEur: Money;
  /** Capital income tax withheld; excluded from the totals above. */
  readonly withheldTaxEur: Money;
};

/** Absolute amount in euros. */
const magnitudeEur = (txn: Txn): Money => {
  const minor = txn.amount.minor < 0n ? -txn.amount.minor : txn.amount.minor;
  return toEur(money(minor, txn.amount.currency), txn.fxRateEur, "half-up");
};

/**
 * What investing cost per year. Tax withheld on an OST is booked as `FEE` by the importer
 * (the broker's capital-income-tax row, so it is not a withdrawal in returns) but is tax, not a cost: counting it
 * would more than double fees, so it is reported separately.
 */
export const feesByYear = (args: {
  readonly txns: readonly Txn[];
  readonly ostAccountIds: ReadonlySet<number>;
}): readonly FeeYear[] => {
  const byYear = new Map<number, { trade: Money; charged: Money; withheld: Money }>();
  const entry = (year: number) =>
    byYear.get(year) ?? {
      trade: zeroMoney(EUR),
      charged: zeroMoney(EUR),
      withheld: zeroMoney(EUR),
    };

  for (const txn of args.txns) {
    const year = Number(txn.tradeDate.slice(0, 4));
    const current = entry(year);

    if (txn.fee.minor !== 0n) {
      const fee = toEur(txn.fee, txn.fxRateEur, "half-up");
      byYear.set(year, { ...current, trade: addMoney(current.trade, fee) });
    }

    if (txn.type !== "FEE") continue;
    const after = entry(year);
    const amount = magnitudeEur(txn);
    byYear.set(
      year,
      args.ostAccountIds.has(txn.accountId)
        ? { ...after, withheld: addMoney(after.withheld, amount) }
        : { ...after, charged: addMoney(after.charged, amount) },
    );
  }

  return [...byYear]
    .map(([year, totals]): FeeYear => ({
      year,
      tradeFeesEur: totals.trade,
      chargedFeesEur: totals.charged,
      totalEur: addMoney(totals.trade, totals.charged),
      withheldTaxEur: totals.withheld,
    }))
    .filter((row) => row.totalEur.minor !== 0n || row.withheldTaxEur.minor !== 0n)
    .sort((a, b) => b.year - a.year);
};
