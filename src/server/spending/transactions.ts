import { formatMoney, EUR } from "../../core/money.ts";
import type { IsoDate, Txn } from "../../core/types.ts";
import { internalTransferIds, investmentPaymentIds } from "./internal.ts";
import { categoriseWith, type SpendingRule } from "./rules.ts";

type ExcludedReason =
  | "income"
  | "internal-transfer"
  | "investment"
  | "opening-balance"
  | "other-currency";

type ClassifiedTxn = {
  readonly id: number;
  readonly date: IsoDate;
  readonly text: string;
  readonly amountEur: string;
  readonly category: string;
  readonly categoryLabel: string;
  readonly counted: boolean;
  readonly excludedReason: ExcludedReason | null;
};

/** Every bank movement in a period with its class and, where excluded from spending, the reason, so a summary can be opened and checked. */
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
