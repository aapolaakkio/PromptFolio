import { formatMoney, EUR } from "../../core/money.ts";
import type { IsoDate, Txn } from "../../core/types.ts";
import { internalTransferIds, investmentPaymentIds } from "./internal.ts";
import { categoriseWith, type SpendingRule } from "./rules.ts";

/** Why a row is not counted as spending, or `null` when it is. */
type ExcludedReason =
  | "income"
  | "internal-transfer"
  | "investment"
  | "opening-balance"
  | "other-currency";

export type ClassifiedTxn = {
  readonly id: number;
  readonly date: IsoDate;
  /** The broker's or bank's own text, which is what the rules match on. */
  readonly text: string;
  readonly amountEur: string;
  /** The category a rule gave it, or `muu` when none matched. */
  readonly category: string;
  readonly categoryLabel: string;
  readonly counted: boolean;
  readonly excludedReason: ExcludedReason | null;
};

/**
 * Every bank movement in a period, with the class it was given and, where it
 * was left out of the spending figures, which rule left it out.
 *
 * The categorised totals are summaries, and a summary a person cannot open is
 * one they have to trust. This is the ledger behind them: it shows the same
 * exclusions the totals apply -- income, internal transfers, money that funded
 * an investment, opening balances -- as reasons on the row rather than as rows
 * that quietly are not there.
 */
export const classifiedTransactions = (args: {
  readonly txns: readonly Txn[];
  readonly rules: readonly SpendingRule[];
  readonly bankAccountIds: ReadonlySet<number>;
  readonly cashlessAccountIds: ReadonlySet<number>;
  readonly labelFor: (category: string) => string;
  readonly from: IsoDate;
  readonly to: IsoDate;
}): readonly ClassifiedTxn[] => {
  const internal = internalTransferIds(args.txns);
  const invested = investmentPaymentIds(args.txns, args.cashlessAccountIds, args.bankAccountIds);

  const reasonFor = (txn: Txn): ExcludedReason | null => {
    if (txn.type === "OPENING_BALANCE") return "opening-balance";
    if (internal.has(txn.id)) return "internal-transfer";
    if (invested.has(txn.id)) return "investment";
    if (txn.currency !== EUR) return "other-currency";
    if (txn.amount.minor >= 0n) return "income";
    return null;
  };

  return args.txns
    .filter(
      (txn) =>
        args.bankAccountIds.has(txn.accountId) &&
        txn.tradeDate >= args.from &&
        txn.tradeDate <= args.to,
    )
    .map((txn): ClassifiedTxn => {
      const excludedReason = reasonFor(txn);
      const category = categoriseWith(txn.note ?? "", args.rules);
      return {
        id: txn.id,
        date: txn.tradeDate,
        text: txn.note ?? "",
        amountEur: formatMoney(txn.amount),
        category,
        categoryLabel: args.labelFor(category),
        counted: excludedReason === null,
        excludedReason,
      };
    })
    .sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1));
};
