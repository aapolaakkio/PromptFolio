import { addMoney, EUR, formatMoney, zeroMoney, type Money } from "../../core/money";
import type { IsoDate, Txn } from "../../core/types";
import { CATEGORY_LABELS, type Category } from "./categories";
import { categoriseWith, isRefund, type SpendingRule } from "./rules";

export type SpendingGroup = {
  readonly key: string;
  readonly label: string;
  /** Always negative or zero: this is money that left. */
  readonly totalEur: string;
  readonly count: number;
};

export type SpendingSummary = {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly totalEur: string;
  readonly groups: SpendingGroup[];
  /**
   * Rows that could not be attributed to any rule, as a share of the total.
   * Always reported: a spending answer that quietly leaves out a third of the
   * money is worse than no answer, and the reader cannot tell without this.
   */
  readonly uncategorisedShare: number;
};

/** One transaction, reduced to what a spending view needs. */
export type SpendingRow = { readonly note: string; readonly amount: Money; readonly date: IsoDate };

const groupKey = (
  row: SpendingRow,
  by: "category" | "counterparty",
  rules: readonly SpendingRule[],
): [string, string] => {
  if (by === "category") {
    const category: Category = categoriseWith(row.note, rules);
    return [category, CATEGORY_LABELS[category]];
  }
  // The counterparty is the note's middle field when the bank printed one
  // ("PKORTTIMAKSU — K-MARKET ESIMERKKI"), and the label itself otherwise.
  const parts = row.note.split(" — ");
  const name = (parts.length > 1 ? parts[1] : parts[0]) ?? "";
  return [name.toUpperCase(), name === "" ? "Nimetön" : name];
};

/**
 * What was spent between two dates, grouped and already added up.
 *
 * Summing happens here rather than in the assistant's prose because the model is
 * forbidden from doing arithmetic (chat/runner.ts's system prompt) -- an answer
 * about a year of groceries has to be a figure the code computed, or it is a
 * guess wearing a euro sign.
 *
 * Only money leaving is counted. A salary is not negative spending, and netting
 * it against the shopping would produce a "food" total that moves when someone
 * gets paid.
 *
 * `txns` must already be restricted to bank accounts. A share purchase is money
 * leaving an account too, and counting it here would report an investment as
 * expenditure -- the largest "spending" of the year would be the year's biggest
 * buy. Callers use `Portfolio.bankAccountIds` for that.
 */
export const summariseSpending = (
  txns: readonly Txn[],
  args: {
    from: IsoDate;
    to: IsoDate;
    by: "category" | "counterparty";
    /** The user's own rules -- see spending/rules.ts. */
    rules: readonly SpendingRule[];
    /** Groups to return, largest first. The rest are folded into one "muut" row. */
    limit?: number;
  },
): SpendingSummary => {
  const rows: SpendingRow[] = txns
    .filter((txn) => txn.tradeDate >= args.from && txn.tradeDate <= args.to)
    // An opening balance is what an account already held, not money spent. A
    // negative one -- the ledger showing more outgoings than the bank's stated
    // balance explains -- was being reported as the year's largest expense.
    .filter((txn) => txn.type !== "OPENING_BALANCE")
    // Refunds are kept even though they are positive: a shop giving money back
    // reduces what was spent there rather than earning anything, so it belongs
    // against its own category. Every other credit is income and is not
    // spending at all.
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
    .filter((row) => categoriseWith(row.note, args.rules) === "muu")
    .reduce((sum, row) => addMoney(sum, row.amount), zeroMoney(EUR));

  const sorted = [...totals.entries()]
    .map(([key, entry]) => ({
      key,
      label: entry.label,
      total: entry.total,
      count: entry.count,
    }))
    // Most spent first, which is what a person asks about.
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

  // The tail is folded into one row rather than dropped: the groups must still
  // add up to the total, or a reader adding them by eye gets a different answer
  // from the one the tool reported.
  if (rest.length > 0) {
    groups.push({
      key: "muut",
      label: `Muut (${rest.length})`,
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
    // A magnitude ratio, not a signed one: both figures are negative, and
    // dividing them directly yields -0 when nothing was left unclassified,
    // which reads as a different number to anyone comparing against 0.
    uncategorisedShare:
      total.minor === 0n ? 0 : Math.abs(Number(uncategorised.minor) / Number(total.minor)),
  };
};
