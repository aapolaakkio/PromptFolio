import { addMoney, toEur, zeroMoney, EUR, type Money } from "../money";
import type { IsoDate, Txn } from "../types";
import { DIVIDEND_TAXABLE_PERCENT, percentOf } from "./rates";

/**
 * One dividend as it appears on a tax return: 85 % of the gross is taxable
 * capital income, 15 % is exempt.
 *
 * `withholdingRecorded` is the honest part. The payer of a Finnish listed
 * dividend withholds 25.5 % at source, so the cash that arrives is net -- but
 * neither broker export separates that withholding: both publish one combined
 * "Kulut / Korot / Verot" column, which the importer maps to `fee`. Every
 * dividend in a real ledger therefore carries `tax = 0`, and `grossEur` below
 * is only a true gross when the broker reported one.
 *
 * The flag is carried rather than the difference guessed. Dividing the net by
 * 0.745 to recover a gross would be right for a Finnish listed share and wrong
 * for every foreign one, whose rate is set by a treaty this ledger knows
 * nothing about -- the kind of confident, unverifiable figure the rest of this
 * codebase refuses to print.
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
        // Nothing inside an equity savings account is taxed when it happens;
        // the dividend is taxed as part of the eventual withdrawal.
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

/** The year's taxable dividend income -- 85 % of each gross, summed. */
export const totalDividendTaxable = (rows: readonly TaxableDividend[]): Money =>
  rows.reduce((sum, row) => addMoney(sum, row.taxableEur), zeroMoney(EUR));
