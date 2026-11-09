import { addMoney, toEur, zeroMoney, EUR, type Money } from "../money.ts";
import type { IsoDate, Txn } from "../types.ts";
import { DIVIDEND_TAXABLE_PERCENT, percentOf } from "./rates.ts";

/**
 * One dividend as on a tax return (85 % taxable). Neither broker export separates withholding (one
 * combined "Kulut / Korot / Verot" column, mapped to `fee`), so `tax` is usually 0 and `grossEur`
 * is a true gross only when `withholdingRecorded`. Grossing up by 0.745 would be wrong for foreign
 * shares, so it is not guessed.
 */
export type TaxableDividend = {
  readonly accountId: number;
  readonly instrumentId: number | null;
  readonly paidOn: IsoDate;
  readonly grossEur: Money;
  readonly withheldEur: Money;
  readonly taxableEur: Money;
  readonly withholdingRecorded: boolean;
};

export const taxableDividends = (args: {
  readonly txns: readonly Txn[];
  readonly ostAccountIds: ReadonlySet<number>;
  readonly from: IsoDate;
  readonly to: IsoDate;
}): TaxableDividend[] =>
  args.txns
    .filter(
      (t) =>
        t.type === "DIVIDEND" &&
        // OST dividends are taxed with the eventual withdrawal.
        !args.ostAccountIds.has(t.accountId) &&
        t.tradeDate >= args.from &&
        t.tradeDate <= args.to,
    )
    .map((t): TaxableDividend => {
      const withheldEur = toEur(t.tax, t.fxRateEur, "half-up");
      const grossEur = addMoney(toEur(t.amount, t.fxRateEur, "half-up"), withheldEur);
      return {
        accountId: t.accountId,
        instrumentId: t.instrumentId,
        paidOn: t.tradeDate,
        grossEur,
        withheldEur,
        taxableEur: percentOf(grossEur, DIVIDEND_TAXABLE_PERCENT),
        withholdingRecorded: t.tax.minor !== 0n,
      };
    });

/** Summed taxable dividend income. */
export const totalDividendTaxable = (rows: readonly TaxableDividend[]): Money =>
  rows.reduce((sum, row) => addMoney(sum, row.taxableEur), zeroMoney(EUR));
