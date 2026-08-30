import { addMoney, EUR, formatMoney, zeroMoney, type Money } from "../../core/money.ts";
import type { IsoDate, Txn } from "../../core/types.ts";
import { internalTransferIds } from "./internal.ts";
import { categoriseWith, isRefund, type SpendingRule } from "./rules.ts";

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
 * Income and spending per month. Transfers between the owner's own accounts are
 * out of both sides -- neither earned nor spent, and counting them makes a month
 * look richer and poorer at once. Empty months are still returned, so a chart
 * shows the gap rather than closing it.
 */
/**
 * How many months one report may cover: fifty years, which is longer than any
 * ledger this app will hold and short enough to draw.
 */
const MAX_MONTHS = 600;

/**
 * The months to report, newest last and capped. A date field being typed into
 * passes through partial values -- "0006-08-06" on the way to "2006-08-06" --
 * and obeying one asks for twenty-four thousand empty months. The cap keeps the
 * end of the range, which is what anyone typing a date is looking at.
 */
const monthsToReport = (from: IsoDate, to: IsoDate): string[] => {
  const months: string[] = [];
  const cursor = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${to.slice(0, 7)}-01T00:00:00Z`);
  for (; cursor <= end; cursor.setUTCMonth(cursor.getUTCMonth() + 1)) {
    months.push(cursor.toISOString().slice(0, 7));
  }
  return months.length <= MAX_MONTHS ? months : months.slice(-MAX_MONTHS);
};

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
    if (txn.amount.minor > 0n && isRefund(txn.note ?? "")) {
      // Money back from a shop lowers the month's spending; it is not income.
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
  /** One entry per category that had any spending in the whole period. */
  readonly byCategory: Readonly<Record<string, string>>;
};

export type MonthlyCategories = {
  /** The categories that appear at all, biggest total first, so colours stay stable. */
  readonly categories: readonly { readonly key: string; readonly label: string }[];
  readonly months: readonly CategoryMonth[];
};

/**
 * Spending per category per month -- whether a category is creeping upward,
 * which one period cannot say however well it is drawn.
 *
 * Ordered by the whole period's total rather than this month's, so a category
 * keeps its colour as the months change. Same exclusions as the flow view.
 */
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
    if (category === "siirrot") continue;

    const month = txn.tradeDate.slice(0, 7);
    // Negative for a refund, which is the point: it comes off the category.
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
      // Every category appears every month, at zero where nothing was spent:
      // a stacked chart with holes in one series reads as missing data rather
      // than as a quiet month.
      byCategory: Object.fromEntries(
        categories.map((category) => [
          category.key,
          formatMoney(perMonth.get(month)?.get(category.key) ?? zeroMoney(EUR)),
        ]),
      ),
    })),
  };
};
