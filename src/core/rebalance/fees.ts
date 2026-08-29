import { addMoney, money, toEur, zeroMoney, EUR, type Money } from "../money";
import type { Txn } from "../types";

export type FeeYear = {
  readonly year: number;
  /** Commission charged on a trade, carried on the transaction itself. */
  readonly tradeFeesEur: Money;
  /** The broker's own charges: a savings plan's service fee, custody. */
  readonly chargedFeesEur: Money;
  readonly totalEur: Money;
  /** Capital income tax withheld. Excluded from the totals above -- see below. */
  readonly withheldTaxEur: Money;
};

/** The magnitude of an amount in euros, whichever way it was signed. */
const magnitudeEur = (txn: Txn): Money => {
  const minor = txn.amount.minor < 0n ? -txn.amount.minor : txn.amount.minor;
  return toEur(money(minor, txn.amount.currency), txn.fxRateEur, "half-up");
};

/**
 * What investing has cost, per year.
 *
 * **Capital income tax withheld on an equity savings account is not a fee.**
 * The broker books it as one -- `import/brokers.ts` maps `PÄÄOMATULOVERO OST`
 * to `FEE` deliberately, because the money leaves permanently without reaching
 * the investor and calling it a withdrawal would tell the money-weighted return
 * it was money taken out and enjoyed. For a report on the cost of investing it
 * is neither: it is tax on a gain the owner made.
 *
 * In a real ledger those rows are most of the `FEE` total in the years they
 * appear, so counting them would overstate fees by more than half and make fee
 * drag meaningless. They are reported separately instead, under their own name,
 * because the figure is worth seeing -- just not as a fee.
 */
export const feesByYear = (args: {
  readonly txns: readonly Txn[];
  /** Accounts whose `FEE` rows are withheld tax rather than a charge. */
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
