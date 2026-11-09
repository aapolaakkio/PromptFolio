import { addMoney, EUR, formatMoney, zeroMoney, type Money } from "../../core/money.ts";
import type { IsoDate, Txn } from "../../core/types.ts";
import { internalTransferIds } from "./internal.ts";
import { categoriseWith, isRefund, type SpendingRule } from "./rules.ts";

type MonthlyFlow = {
  readonly month: string;
  readonly incomeEur: string;
  readonly expensesEur: string;
  readonly netEur: string;
};

const MAX_MONTHS = 600;

// Capped, keeping the end of the range: a date field mid-typing ("0006-08-06") would otherwise ask for 24,000 empty months.
const monthsToReport = (from: IsoDate, to: IsoDate): string[] => {
  const months: string[] = [];
  const cursor = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${to.slice(0, 7)}-01T00:00:00Z`);
  for (; cursor <= end; cursor.setUTCMonth(cursor.getUTCMonth() + 1)) {
    months.push(cursor.toISOString().slice(0, 7));
  }
  return months.length <= MAX_MONTHS ? months : months.slice(-MAX_MONTHS);
};

/** Income and spending per month; own-account transfers are out of both sides. Empty months are returned so a chart shows the gap. */
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
    if (categoriseWith(txn.note ?? "", args.rules) === "transfers") continue;

    const month = txn.tradeDate.slice(0, 7);
    if (txn.amount.minor > 0n && isRefund(txn.note ?? "")) {
      const negative: Money = { minor: -txn.amount.minor, currency: EUR };
      expenses.set(month, addMoney(expenses.get(month) ?? zeroMoney(EUR), negative));
    } else if (txn.amount.minor > 0n) {
      income.set(month, addMoney(income.get(month) ?? zeroMoney(EUR), txn.amount));
    } else if (txn.amount.minor < 0n) {
      const positive: Money = { minor: -txn.amount.minor, currency: EUR };
      expenses.set(month, addMoney(expenses.get(month) ?? zeroMoney(EUR), positive));
    }
  }

  const months = monthsToReport(args.from, args.to);

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

export type CategoryMonth = {
  readonly month: string;
  readonly byCategory: Readonly<Record<string, string>>;
};

type MonthlyCategories = {
  readonly categories: readonly { readonly key: string; readonly label: string }[];
  readonly months: readonly CategoryMonth[];
};

/** Spending per category per month, ordered by the whole period's total so colours stay stable. Same exclusions as the flow view. */
export const monthlyByCategory = (args: {
  txns: readonly Txn[];
  rules: readonly SpendingRule[];
  bankAccountIds: ReadonlySet<number>;
  labelFor: (category: string) => string;
  from: IsoDate;
  to: IsoDate;
}): MonthlyCategories => {
  const internal = internalTransferIds(args.txns);
  const perMonth = new Map<string, Map<string, Money>>();
  const totals = new Map<string, Money>();

  for (const txn of args.txns) {
    if (!args.bankAccountIds.has(txn.accountId)) continue;
    if (internal.has(txn.id)) continue;
    if (txn.tradeDate < args.from || txn.tradeDate > args.to) continue;
    if (txn.currency !== EUR) continue;
    if (txn.type === "OPENING_BALANCE") continue;
    if (txn.amount.minor >= 0n && !isRefund(txn.note ?? "")) continue;

    const category = categoriseWith(txn.note ?? "", args.rules);
    if (category === "transfers") continue;

    const month = txn.tradeDate.slice(0, 7);
    const spent: Money = { minor: -txn.amount.minor, currency: EUR };
    const row = perMonth.get(month) ?? new Map<string, Money>();
    row.set(category, addMoney(row.get(category) ?? zeroMoney(EUR), spent));
    perMonth.set(month, row);
    totals.set(category, addMoney(totals.get(category) ?? zeroMoney(EUR), spent));
  }

  const categories = [...totals]
    .sort((a, b) => Number(b[1].minor - a[1].minor))
    .map(([key]) => ({ key, label: args.labelFor(key) }));

  const months = monthsToReport(args.from, args.to);

  return {
    categories,
    months: months.map((month) => ({
      month,
      // Every category appears every month, at zero: a hole in a stacked series reads as missing data.
      byCategory: Object.fromEntries(
        categories.map((category) => [
          category.key,
          formatMoney(perMonth.get(month)?.get(category.key) ?? zeroMoney(EUR)),
        ]),
      ),
    })),
  };
};
