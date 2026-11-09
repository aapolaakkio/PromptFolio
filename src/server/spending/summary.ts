import { addMoney, EUR, formatMoney, zeroMoney, type Money } from "../../core/money.ts";
import type { IsoDate, Txn } from "../../core/types.ts";
import { CATEGORY_LABELS, type Category } from "./categories.ts";
import { categoriseWith, isRefund, type SpendingRule } from "./rules.ts";

type SpendingGroup = {
  readonly key: string;
  readonly label: string;
  readonly totalEur: string;
  readonly count: number;
};

type SpendingSummary = {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly totalEur: string;
  readonly groups: SpendingGroup[];
  /** Share of the total not attributed to any rule; always reported, as a spending answer that hides a third of the money is worse than none. */
  readonly uncategorisedShare: number;
};

type SpendingRow = { readonly note: string; readonly amount: Money; readonly date: IsoDate };

export const groupKey = (
  row: SpendingRow,
  by: "category" | "counterparty",
  rules: readonly SpendingRule[],
): [string, string] => {
  if (by === "category") {
    const category: Category = categoriseWith(row.note, rules);
    return [category, CATEGORY_LABELS[category]];
  }
  // The counterparty is the note's middle field when the bank printed one ("PKORTTIMAKSU — K-MARKET EXAMPLE"), else the label.
  const parts = row.note.split(" — ");
  const name = (parts.length > 1 ? parts[1] : parts[0]) ?? "";
  return [name.toUpperCase(), name === "" ? "Unnamed" : name];
};

/**
 * What was spent between two dates, grouped and summed (the model may not do arithmetic).
 * Only money leaving counts, so pay does not net against shopping. `txns` must be bank accounts
 * only (`Portfolio.bankAccountIds`), or a share purchase would be reported as spending.
 */
export const summariseSpending = (
  txns: readonly Txn[],
  args: {
    from: IsoDate;
    to: IsoDate;
    by: "category" | "counterparty";
    rules: readonly SpendingRule[];
    limit?: number;
  },
): SpendingSummary => {
  const rows: SpendingRow[] = txns
    .filter((txn) => txn.tradeDate >= args.from && txn.tradeDate <= args.to)
    // An opening balance is what the account already held, not spending (a negative one once topped the expenses).
    .filter((txn) => txn.type !== "OPENING_BALANCE")
    // Refunds stay: a shop giving money back reduces spending in its own category. Other credits are income.
    .filter((txn) => txn.currency === EUR && (txn.amount.minor < 0n || isRefund(txn.note ?? "")))
    .map((txn) => ({ note: txn.note ?? "", amount: txn.amount, date: txn.tradeDate }));

  const totals = new Map<string, { label: string; total: Money; count: number }>();
  for (const row of rows) {
    const [key, label] = groupKey(row, args.by, args.rules);
    const existing = totals.get(key);
    totals.set(key, {
      label,
      total: addMoney(existing?.total ?? zeroMoney(EUR), row.amount),
      count: (existing?.count ?? 0) + 1,
    });
  }

  const total = rows.reduce((sum, row) => addMoney(sum, row.amount), zeroMoney(EUR));
  const uncategorised = rows
    .filter((row) => categoriseWith(row.note, args.rules) === "other")
    .reduce((sum, row) => addMoney(sum, row.amount), zeroMoney(EUR));

  const sorted = [...totals.entries()]
    .map(([key, entry]) => ({
      key,
      label: entry.label,
      total: entry.total,
      count: entry.count,
    }))
    .sort((a, b) => (a.total.minor === b.total.minor ? 0 : a.total.minor < b.total.minor ? -1 : 1));

  const limit = args.limit ?? sorted.length;
  const kept = sorted.slice(0, limit);
  const rest = sorted.slice(limit);
  const groups: SpendingGroup[] = kept.map((entry) => ({
    key: entry.key,
    label: entry.label,
    totalEur: formatMoney(entry.total),
    count: entry.count,
  }));

  // The tail is folded into one row so the groups still add up to the total.
  if (rest.length > 0) {
    groups.push({
      key: "muut",
      label: `Other (${rest.length})`,
      totalEur: formatMoney(
        rest.reduce((sum, entry) => addMoney(sum, entry.total), zeroMoney(EUR)),
      ),
      count: rest.reduce((sum, entry) => sum + entry.count, 0),
    });
  }

  return {
    from: args.from,
    to: args.to,
    totalEur: formatMoney(total),
    groups,
    // A magnitude ratio: dividing two negatives yields -0 when nothing was unclassified.
    uncategorisedShare:
      total.minor === 0n ? 0 : Math.abs(Number(uncategorised.minor) / Number(total.minor)),
  };
};
