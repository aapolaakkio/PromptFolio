import type { Disposal } from "../costbasis.ts";
import { addMoney, negateMoney, subMoney, zeroMoney, EUR, type Money } from "../money.ts";
import type { IsoDate, Txn } from "../types.ts";
import { taxableDisposals, type TaxableDisposal } from "./disposals.ts";
import { taxableDividends, totalDividendTaxable, type TaxableDividend } from "./dividends.ts";
import type { OstReport, OstValuation } from "./ost.ts";
import { ostReport } from "./ost.ts";
import { LOSS_CARRY_YEARS, SMALL_SALE_LIMIT_EUR } from "./rates.ts";

/** A loss from an earlier year, still deductible. */
type CarriedLoss = { readonly fromYear: number; readonly amountEur: Money };

export type TaxYear = {
  readonly year: number;
  readonly disposals: readonly TaxableDisposal[];
  /** Gross sale prices; the 1 000 € exemption is measured on these. */
  readonly totalSalePriceEur: Money;
  readonly exempt: boolean;
  readonly gainsEur: Money;
  readonly lossesEur: Money;
  /** Gains less losses, after the exemption, floored at zero. */
  readonly netEur: Money;
  readonly lossesUsedEur: Money;
  readonly lossCarriedIn: readonly CarriedLoss[];
  readonly lossCarriedOut: readonly CarriedLoss[];
  readonly dividends: readonly TaxableDividend[];
  readonly dividendTaxableEur: Money;
  readonly ost: readonly { readonly accountId: number; readonly report: OstReport }[];
};

const yearOf = (date: IsoDate): number => Number(date.slice(0, 4));
const sum = (amounts: readonly Money[]): Money =>
  amounts.reduce((total, amount) => addMoney(total, amount), zeroMoney(EUR));

/**
 * Keeps disposals a SELL produced (`buildLots` also records TRANSFER_OUT, not a sale). Matched on
 * account, instrument and date; a same-day transfer and sale are indistinguishable and the sale wins.
 */
const soldOnly = (disposals: readonly Disposal[], txns: readonly Txn[]): Disposal[] => {
  const sold = new Set(
    txns
      .filter((t) => t.type === "SELL" && t.instrumentId !== null)
      .map((t) => `${t.accountId}:${t.instrumentId}:${t.tradeDate}`),
  );
  return disposals.filter((d) => sold.has(`${d.accountId}:${d.instrumentId}:${d.soldOn}`));
};

/** One year's realised result, before any carried loss is applied. */
const resultFor = (
  disposals: readonly Disposal[],
  txns: readonly Txn[],
  ostAccountIds: ReadonlySet<number>,
  year: number,
) => {
  const rows = taxableDisposals({
    disposals: soldOnly(disposals, txns).filter((d) => yearOf(d.soldOn) === year),
    ostAccountIds,
  });
  const totalSalePriceEur = sum(rows.map((row) => row.grossProceedsEur));
  const exempt = totalSalePriceEur.minor <= SMALL_SALE_LIMIT_EUR.minor;
  const gains = rows.filter((row) => row.gainEur.minor > 0n).map((row) => row.gainEur);
  const losses = rows
    .filter((row) => row.gainEur.minor < 0n)
    .map((row) => negateMoney(row.gainEur));

  // Under the threshold gains are exempt and losses non-deductible.
  return {
    rows,
    totalSalePriceEur,
    exempt,
    gainsEur: exempt ? zeroMoney(EUR) : sum(gains),
    lossesEur: exempt ? zeroMoney(EUR) : sum(losses),
  };
};

export const taxYear = (args: {
  readonly txns: readonly Txn[];
  readonly disposals: readonly Disposal[];
  readonly ostAccountIds: ReadonlySet<number>;
  readonly ostValueAt: (accountId: number, on: IsoDate, beforeTxnId: number) => OstValuation;
  readonly year: number;
}): TaxYear => {
  const { year, txns, disposals, ostAccountIds } = args;
  const current = resultFor(disposals, txns, ostAccountIds, year);

  // Prior years' losses, oldest first, net of the gains of their own year and every year since.
  const carried: CarriedLoss[] = [];
  for (let from = year - LOSS_CARRY_YEARS; from < year; from++) {
    const past = resultFor(disposals, txns, ostAccountIds, from);
    let unused = subMoney(past.lossesEur, past.gainsEur);
    if (unused.minor <= 0n) continue;
    for (let after = from + 1; after < year && unused.minor > 0n; after++) {
      const later = resultFor(disposals, txns, ostAccountIds, after);
      const absorbed = later.gainsEur.minor < unused.minor ? later.gainsEur : unused;
      unused = subMoney(unused, absorbed);
    }
    if (unused.minor > 0n) carried.push({ fromYear: from, amountEur: unused });
  }

  // Own losses first, then carried ones oldest first (soonest to expire).
  let remainingGains = subMoney(current.gainsEur, current.lossesEur);
  const carriedOut: CarriedLoss[] = [];
  let lossesUsed =
    current.lossesEur.minor > current.gainsEur.minor ? current.gainsEur : current.lossesEur;

  for (const loss of carried) {
    if (remainingGains.minor <= 0n) {
      carriedOut.push(loss);
      continue;
    }
    const used = loss.amountEur.minor < remainingGains.minor ? loss.amountEur : remainingGains;
    remainingGains = subMoney(remainingGains, used);
    lossesUsed = addMoney(lossesUsed, used);
    const left = subMoney(loss.amountEur, used);
    if (left.minor > 0n) carriedOut.push({ fromYear: loss.fromYear, amountEur: left });
  }

  const ownLossLeft = subMoney(current.lossesEur, current.gainsEur);
  if (ownLossLeft.minor > 0n) carriedOut.push({ fromYear: year, amountEur: ownLossLeft });

  const ostAccounts = [...ostAccountIds].map((accountId) => ({
    accountId,
    report: ostReport({
      txns: txns.filter((t) => t.accountId === accountId),
      valueAt: (on, beforeTxnId) => args.ostValueAt(accountId, on, beforeTxnId),
      from: `${year}-01-01`,
      to: `${year}-12-31`,
    }),
  }));

  const dividends = taxableDividends({
    txns,
    ostAccountIds,
    from: `${year}-01-01`,
    to: `${year}-12-31`,
  });

  return {
    year,
    disposals: current.rows,
    totalSalePriceEur: current.totalSalePriceEur,
    exempt: current.exempt,
    gainsEur: current.gainsEur,
    lossesEur: current.lossesEur,
    netEur: remainingGains.minor > 0n ? remainingGains : zeroMoney(EUR),
    lossesUsedEur: lossesUsed,
    lossCarriedIn: carried,
    lossCarriedOut: carriedOut,
    dividends,
    dividendTaxableEur: totalDividendTaxable(dividends),
    ost: ostAccounts,
  };
};
