import { addMoney, EUR, formatMoney, zeroMoney, type Money } from "../../core/money.ts";
import type { IsoDate, Txn } from "../../core/types.ts";
import { CATEGORY_LABELS } from "./categories.ts";
import { internalTransferIds, investmentPaymentIds } from "./internal.ts";
import { categoriseWith, isRefund, type SpendingRule } from "./rules.ts";
import { groupKey } from "./summary.ts";

/** Where a period's money came from and went, as a Sankey graph. Amounts are positive: direction is the link's. */
export type FlowNode = { readonly id: string; readonly label: string; readonly totalEur: string };
export type FlowLink = { readonly from: string; readonly to: string; readonly amountEur: string };

export type CashFlow = {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly nodes: FlowNode[];
  readonly links: FlowLink[];
  readonly empty: boolean;
};

/** Income categories, in the order they should stack. Everything else is "other-income" (other income). */
const INCOME_CATEGORIES = ["salary", "interest"] as const;

const negate = (amount: Money): Money => ({ minor: -amount.minor, currency: amount.currency });

/** Payees drawn by name when spending is split by payee; the rest are one node. */
const MAX_PAYEES = 15;

/**
 * Builds the graph for one period. Four flows leave income: spending, investments, tax and a
 * residual. Own-account transfers are neither; money moving to a broker counts once, from the broker's deposits.
 */
export const cashFlowFor = (args: {
  txns: readonly Txn[];
  rules: readonly SpendingRule[];
  bankAccountIds: ReadonlySet<number>;
  investedAccountIds: ReadonlySet<number>;
  cashlessInvestedAccountIds?: ReadonlySet<number>;
  from: IsoDate;
  to: IsoDate;
  /** How spending splits on the right: by category (the default) or by payee. */
  by?: "category" | "counterparty";
}): CashFlow => {
  // Matched over the whole ledger so a transfer booked either side of the period boundary still finds its other half.
  const internal = internalTransferIds(args.txns);
  // A regular fund saving is a bank payment that is really an investment.
  const intoInvestments = investmentPaymentIds(
    args.txns,
    args.cashlessInvestedAccountIds ?? new Set(),
    args.bankAccountIds,
  );
  const inPeriod = args.txns.filter(
    (txn) =>
      txn.tradeDate >= args.from &&
      txn.tradeDate <= args.to &&
      txn.currency === EUR &&
      !internal.has(txn.id),
  );
  const bankRows = inPeriod.filter((txn) => args.bankAccountIds.has(txn.accountId));

  // --- money in, by what the rules make of it ---
  const income = new Map<string, Money>();
  for (const txn of bankRows) {
    if (txn.amount.minor <= 0n) continue;
    if (txn.type === "OPENING_BALANCE") continue;
    // Refunds are already netted against their category.
    if (isRefund(txn.note ?? "")) continue;
    const category = categoriseWith(txn.note ?? "", args.rules);
    // A transfer in is the owner's own money arriving, not income.
    if (category === "transfers") continue;
    const key = INCOME_CATEGORIES.some((known) => known === category) ? category : "other-income";
    income.set(key, addMoney(income.get(key) ?? zeroMoney(EUR), txn.amount));
  }

  // --- money out, by category ---
  const by = args.by ?? "category";
  const expenses = new Map<string, { label: string; amount: Money }>();
  let taxes = zeroMoney(EUR);
  for (const txn of bankRows) {
    // A refund is negative spending in its own category, not income.
    if (txn.amount.minor >= 0n && !isRefund(txn.note ?? "")) continue;
    if (txn.type === "OPENING_BALANCE") continue;
    if (intoInvestments.has(txn.id)) continue;
    const category = categoriseWith(txn.note ?? "", args.rules);
    if (category === "transfers") continue;
    const positive = negate(txn.amount);
    if (category === "taxes") {
      taxes = addMoney(taxes, positive);
      continue;
    }
    const [key, label] = groupKey(
      { note: txn.note ?? "", amount: txn.amount, date: txn.tradeDate },
      by,
      args.rules,
    );
    const existing = expenses.get(key);
    expenses.set(key, { label, amount: addMoney(existing?.amount ?? zeroMoney(EUR), positive) });
  }

  // --- money moved into investments, from the broker's own record ---
  // Read before the internal-transfer filter: a broker deposit is the half of a transfer worth showing.
  const invested = args.txns
    .filter(
      (txn) =>
        txn.tradeDate >= args.from &&
        txn.tradeDate <= args.to &&
        txn.currency === EUR &&
        args.investedAccountIds.has(txn.accountId) &&
        txn.type === "DEPOSIT",
    )
    .reduce((sum, txn) => addMoney(sum, txn.amount), zeroMoney(EUR));

  // ...plus the payments that funded purchases at a broker recording no cash.
  const investedFromBank = args.txns
    .filter(
      (txn) =>
        intoInvestments.has(txn.id) && txn.tradeDate >= args.from && txn.tradeDate <= args.to,
    )
    .reduce((sum, txn) => addMoney(sum, negate(txn.amount)), zeroMoney(EUR));
  const investedTotal = addMoney(invested, investedFromBank);

  const totalIn = [...income.values()].reduce((sum, value) => addMoney(sum, value), zeroMoney(EUR));
  const totalSpent = [...expenses.values()].reduce(
    (sum, entry) => addMoney(sum, entry.amount),
    zeroMoney(EUR),
  );
  const leftover: Money = {
    minor: totalIn.minor - totalSpent.minor - taxes.minor - investedTotal.minor,
    currency: EUR,
  };

  const nodes: FlowNode[] = [];
  const links: FlowLink[] = [];
  // Returns whether the node exists: a link to a missing node throws and takes the page down.
  // Non-positive amounts never become nodes.
  const push = (id: string, label: string, amount: Money): boolean => {
    if (amount.minor <= 0n) return false;
    nodes.push({ id, label, totalEur: formatMoney(amount) });
    return true;
  };

  const incomeLabelFor = (key: string): string =>
    key === "salary" || key === "interest" ? CATEGORY_LABELS[key] : "Other income";

  for (const [key, amount] of income) {
    if (push(`in:${key}`, incomeLabelFor(key), amount)) {
      links.push({ from: `in:${key}`, to: "income", amountEur: formatMoney(amount) });
    }
  }
  push("income", "Income", totalIn);

  if (push("expenses", "Spending", totalSpent)) {
    links.push({ from: "income", to: "expenses", amountEur: formatMoney(totalSpent) });
  }
  if (push("taxes", CATEGORY_LABELS.taxes, taxes)) {
    links.push({ from: "income", to: "taxes", amountEur: formatMoney(taxes) });
  }
  if (push("invested", "Investments", investedTotal)) {
    links.push({ from: "income", to: "invested", amountEur: formatMoney(investedTotal) });
  }
  // Negative residual means the period spent more than it earned.
  push("leftover", leftover.minor >= 0n ? "Left in account" : "Covered from savings", {
    minor: leftover.minor < 0n ? -leftover.minor : leftover.minor,
    currency: EUR,
  });
  if (leftover.minor > 0n) {
    links.push({ from: "income", to: "leftover", amountEur: formatMoney(leftover) });
  } else if (leftover.minor < 0n) {
    links.push({ from: "leftover", to: "income", amountEur: formatMoney(negate(leftover)) });
  }

  const sortedExpenses = [...expenses.entries()].sort((a, b) =>
    a[1].amount.minor === b[1].amount.minor ? 0 : a[1].amount.minor > b[1].amount.minor ? -1 : 1,
  );
  // Past the largest few payees a Sankey is a smear of hairlines.
  const shown = by === "counterparty" ? sortedExpenses.slice(0, MAX_PAYEES) : sortedExpenses;
  const rest = sortedExpenses
    .slice(shown.length)
    .reduce((sum, [, entry]) => addMoney(sum, entry.amount), zeroMoney(EUR));
  const outgoing: [string, { label: string; amount: Money }][] =
    rest.minor > 0n ? [...shown, ["other-payees", { label: "Other payees", amount: rest }]] : shown;
  for (const [key, { label, amount }] of outgoing) {
    if (push(`out:${key}`, label, amount)) {
      links.push({ from: "expenses", to: `out:${key}`, amountEur: formatMoney(amount) });
    }
  }

  return {
    from: args.from,
    to: args.to,
    nodes,
    links,
    empty: totalIn.minor === 0n && totalSpent.minor === 0n && investedTotal.minor === 0n,
  };
};
