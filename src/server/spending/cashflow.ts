import { addMoney, EUR, formatMoney, zeroMoney, type Money } from "../../core/money.ts";
import type { IsoDate, Txn } from "../../core/types.ts";
import { CATEGORY_LABELS } from "./categories.ts";
import { internalTransferIds, investmentPaymentIds } from "./internal.ts";
import { categoriseWith, isRefund, type SpendingRule } from "./rules.ts";
import { groupKey } from "./summary.ts";

/**
 * Where a period's money came from and where it went, as a flow graph.
 *
 * Every amount is positive here: a Sankey's ribbons have width, not sign, and
 * the direction is carried by which node a link runs from. Sums are computed in
 * minor units and cross as decimal strings, like every other figure this app
 * reports.
 */
export type FlowNode = { readonly id: string; readonly label: string; readonly totalEur: string };
export type FlowLink = { readonly from: string; readonly to: string; readonly amountEur: string };

export type CashFlow = {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly nodes: FlowNode[];
  readonly links: FlowLink[];
  /** True when nothing at all moved, so the client can say so rather than draw an empty frame. */
  readonly empty: boolean;
};

/** Income categories, in the order they should stack. Everything else in is "muu tulo". */
const INCOME_CATEGORIES = ["palkka", "korko"] as const;

const negate = (amount: Money): Money => ({ minor: -amount.minor, currency: amount.currency });

/**
 * Builds the graph for one period.
 *
 * Four things leave the income node: what was spent, what went into investment
 * accounts, what the tax authority took, and whatever is left. The last one is
 * a residual rather than a measurement -- it is what the other three do not
 * account for -- and it is labelled as such, because a Sankey that silently
 * balances by inventing a flow is a picture that lies.
 *
 * Transfers between the owner's own accounts are deliberately not income or
 * expense. Money moving from a current account to a brokerage one appears once,
 * as the investment flow, taken from the brokerage account's own deposits
 * rather than from the sending account's transfer rows -- the broker's record
 * is the reliable half, and counting both would double it.
 */
/** Payees drawn by name when spending is split by payee; the rest are one node. */
const MAX_PAYEES = 15;

export const cashFlowFor = (args: {
  txns: readonly Txn[];
  rules: readonly SpendingRule[];
  bankAccountIds: ReadonlySet<number>;
  investedAccountIds: ReadonlySet<number>;
  /** Invested accounts whose export records no cash -- see investmentPaymentIds. */
  cashlessInvestedAccountIds?: ReadonlySet<number>;
  from: IsoDate;
  to: IsoDate;
  /** How spending splits on the right: by category (the default) or by payee. */
  by?: "category" | "counterparty";
}): CashFlow => {
  // Money the owner moved between their own accounts is neither earned nor
  // spent, and text rules cannot tell it apart from a real payment -- see
  // internalTransferIds. Matched over the whole ledger, not just the period, so
  // a transfer booked either side of the boundary still finds its other half.
  const internal = internalTransferIds(args.txns);
  // A regular fund saving leaves the bank as a payment and lands at the broker
  // as a purchase; it is money invested, not money spent, and belongs on the
  // investment branch rather than among the shops.
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
    // A refund was already taken off the category it came from; counting it
    // here as well would show the same money arriving and never leaving.
    if (isRefund(txn.note ?? "")) continue;
    const category = categoriseWith(txn.note ?? "", args.rules);
    // A transfer in is the owner's own money arriving, not income.
    if (category === "siirrot") continue;
    const key = INCOME_CATEGORIES.some((known) => known === category) ? category : "muu-tulo";
    income.set(key, addMoney(income.get(key) ?? zeroMoney(EUR), txn.amount));
  }

  // --- money out, by category ---
  const by = args.by ?? "category";
  const expenses = new Map<string, { label: string; amount: Money }>();
  let taxes = zeroMoney(EUR);
  for (const txn of bankRows) {
    // A refund is negative spending in its own category, not income: nobody
    // earned it, and counting it as income would both inflate what came in and
    // leave the purchase it reverses standing at full price.
    if (txn.amount.minor >= 0n && !isRefund(txn.note ?? "")) continue;
    if (txn.type === "OPENING_BALANCE") continue;
    if (intoInvestments.has(txn.id)) continue;
    const category = categoriseWith(txn.note ?? "", args.rules);
    if (category === "siirrot") continue;
    const positive = negate(txn.amount);
    if (category === "verot") {
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
  // Read from the ledger before the internal filter: a deposit into a brokerage
  // account is exactly the half of an internal transfer worth showing, since
  // "what did I put into investments" is the question this flow answers.
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
  // Reports whether the node now exists, so a link can be made conditional on
  // its own endpoint. A link to a node that was never pushed does not degrade
  // -- it throws, and the whole page goes down with the diagram. Nothing that
  // is not positive becomes a node: a Sankey has no way to draw a flow of zero
  // or of less than nothing.
  const push = (id: string, label: string, amount: Money): boolean => {
    if (amount.minor <= 0n) return false;
    nodes.push({ id, label, totalEur: formatMoney(amount) });
    return true;
  };

  const INCOME_LABELS = {
    palkka: CATEGORY_LABELS.palkka,
    korko: CATEGORY_LABELS.korko,
    "muu-tulo": "Muut tulot",
  } satisfies Record<string, string>;

  const incomeLabelFor = (key: string): string => {
    if (key === "palkka") return INCOME_LABELS.palkka;
    if (key === "korko") return INCOME_LABELS.korko;
    return INCOME_LABELS["muu-tulo"];
  };

  for (const [key, amount] of income) {
    if (push(`in:${key}`, incomeLabelFor(key), amount)) {
      links.push({ from: `in:${key}`, to: "income", amountEur: formatMoney(amount) });
    }
  }
  push("income", "Tulot", totalIn);

  if (push("expenses", "Menot", totalSpent)) {
    links.push({ from: "income", to: "expenses", amountEur: formatMoney(totalSpent) });
  }
  if (push("taxes", CATEGORY_LABELS.verot, taxes)) {
    links.push({ from: "income", to: "taxes", amountEur: formatMoney(taxes) });
  }
  if (push("invested", "Sijoituksiin", investedTotal)) {
    links.push({ from: "income", to: "invested", amountEur: formatMoney(investedTotal) });
  }
  // Named as what it is: the part the other flows do not explain. Negative means
  // the period spent more than it earned, which is a fact worth showing rather
  // than a number to hide.
  push("leftover", leftover.minor >= 0n ? "Jäi tilille" : "Katettu säästöistä", {
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
  // A year has hundreds of payees; past the largest few a Sankey is a smear of
  // hairlines, so the rest are added up into one node.
  const shown = by === "counterparty" ? sortedExpenses.slice(0, MAX_PAYEES) : sortedExpenses;
  const rest = sortedExpenses
    .slice(shown.length)
    .reduce((sum, [, entry]) => addMoney(sum, entry.amount), zeroMoney(EUR));
  const outgoing: [string, { label: string; amount: Money }][] =
    rest.minor > 0n ? [...shown, ["muut-saajat", { label: "Muut saajat", amount: rest }]] : shown;
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
