import { addMoney, EUR, formatMoney, zeroMoney, type Money } from "../../core/money";
import type { IsoDate, Txn } from "../../core/types";
import { internalTransferIds } from "./internal";
import { categoriseWith, type SpendingRule } from "./rules";

export type MonthlyFlow = {
  /** `2026-03`, so the client can sort and label without parsing a date. */
  readonly month: string;
  readonly incomeEur: string;
  /** Positive: what left the account that month. */
  readonly expensesEur: string;
  /** Income minus expenses, which is the number a person actually wants. */
  readonly netEur: string;
};

/**
 * Income and spending per calendar month.
 *
 * Transfers between the owner's own accounts are left out of both sides: money
 * moved from a current account to a brokerage one is neither earned nor spent,
 * and counting it would make a month look both richer and poorer than it was.
 *
 * Months with no movement at all are still returned, so a chart shows the gap
 * rather than closing it and implying continuous activity.
 */
export const monthlyFlows = (args: {
  txns: readonly Txn[];
  rules: readonly SpendingRule[];
  bankAccountIds: ReadonlySet<number>;
  from: IsoDate;
  to: IsoDate;
}): MonthlyFlow[] => {
  const internal = internalTransferIds(args.txns);
  const income = new Map<string, Money>();
  const expenses = new Map<string, Money>();

  for (const txn of args.txns) {
    if (!args.bankAccountIds.has(txn.accountId)) continue;
    if (internal.has(txn.id)) continue;
    if (txn.tradeDate < args.from || txn.tradeDate > args.to) continue;
    if (txn.currency !== EUR) continue;
    if (txn.type === "OPENING_BALANCE") continue;
    if (categoriseWith(txn.note ?? "", args.rules) === "siirrot") continue;

    const month = txn.tradeDate.slice(0, 7);
    if (txn.amount.minor > 0n) {
      income.set(month, addMoney(income.get(month) ?? zeroMoney(EUR), txn.amount));
    } else if (txn.amount.minor < 0n) {
      const positive: Money = { minor: -txn.amount.minor, currency: EUR };
      expenses.set(month, addMoney(expenses.get(month) ?? zeroMoney(EUR), positive));
    }
  }

  const months: string[] = [];
  const start = new Date(`${args.from.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${args.to.slice(0, 7)}-01T00:00:00Z`);
  for (let cursor = start; cursor <= end; cursor.setUTCMonth(cursor.getUTCMonth() + 1)) {
    months.push(cursor.toISOString().slice(0, 7));
  }

  return months.map((month) => {
    const earned = income.get(month) ?? zeroMoney(EUR);
    const spent = expenses.get(month) ?? zeroMoney(EUR);
    return {
      month,
      incomeEur: formatMoney(earned),
      expensesEur: formatMoney(spent),
      netEur: formatMoney({ minor: earned.minor - spent.minor, currency: EUR }),
    };
  });
};
