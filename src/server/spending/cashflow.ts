import { addMoney, EUR, formatMoney, zeroMoney, type Money } from "../../core/money";
import type { IsoDate, Txn } from "../../core/types";
import { CATEGORY_LABELS } from "./categories";
import { internalTransferIds, investmentPaymentIds } from "./internal";
import { categoriseWith, type SpendingRule } from "./rules";

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
export const cashFlowFor = (args: {
  txns: readonly Txn[];
  rules: readonly SpendingRule[];
  bankAccountIds: ReadonlySet<number>;
  investedAccountIds: ReadonlySet<number>;
  /** Invested accounts whose export records no cash -- see investmentPaymentIds. */
  cashlessInvestedAccountIds?: ReadonlySet<number>;
  from: IsoDate;
  to: IsoDate;
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
    const category = categoriseWith(txn.note ?? "", args.rules);
    // A transfer in is the owner's own money arriving, not income.
    if (category === "siirrot") continue;
    const key = INCOME_CATEGORIES.some((known) => known === category) ? category : "muu-tulo";
    income.set(key, addMoney(income.get(key) ?? zeroMoney(EUR), txn.amount));
  }

  // --- money out, by category ---
  const expenses = new Map<string, Money>();
  let taxes = zeroMoney(EUR);
  for (const txn of bankRows) {
    if (txn.amount.minor >= 0n) continue;
    if (txn.type === "OPENING_BALANCE") continue;
    if (intoInvestments.has(txn.id)) continue;
    const category = categoriseWith(txn.note ?? "", args.rules);
    if (category === "siirrot") continue;
    const positive = negate(txn.amount);
    if (category === "verot") {
      taxes = addMoney(taxes, positive);
      continue;
    }
    expenses.set(category, addMoney(expenses.get(category) ?? zeroMoney(EUR), positive));
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
    (sum, value) => addMoney(sum, value),
    zeroMoney(EUR),
  );
  const leftover: Money = {
    minor: totalIn.minor - totalSpent.minor - taxes.minor - investedTotal.minor,
    currency: EUR,
  };

  const nodes: FlowNode[] = [];
  const links: FlowLink[] = [];
  const push = (id: string, label: string, amount: Money): void => {
    if (amount.minor <= 0n) return;
    nodes.push({ id, label, totalEur: formatMoney(amount) });
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
    push(`in:${key}`, incomeLabelFor(key), amount);
    if (amount.minor > 0n) {
      links.push({ from: `in:${key}`, to: "income", amountEur: formatMoney(amount) });
    }
  }
  push("income", "Tulot", totalIn);

  push("expenses", "Menot", totalSpent);
  if (totalSpent.minor > 0n) {
    links.push({ from: "income", to: "expenses", amountEur: formatMoney(totalSpent) });
  }
  push("taxes", CATEGORY_LABELS.verot, taxes);
  if (taxes.minor > 0n) {
    links.push({ from: "income", to: "taxes", amountEur: formatMoney(taxes) });
  }
  push("invested", "Sijoituksiin", investedTotal);
  if (investedTotal.minor > 0n) {
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
    a[1].minor === b[1].minor ? 0 : a[1].minor > b[1].minor ? -1 : 1,
  );
  for (const [category, amount] of sortedExpenses) {
    // SAFETY: `expenses` is keyed by `categoriseWith`, whose return type is the
    // Category union that CATEGORY_LABELS is declared complete over.
    const label = CATEGORY_LABELS[category as keyof typeof CATEGORY_LABELS] ?? category;
    push(`out:${category}`, label, amount);
    links.push({ from: "expenses", to: `out:${category}`, amountEur: formatMoney(amount) });
  }

  return {
    from: args.from,
    to: args.to,
    nodes,
    links,
    empty: totalIn.minor === 0n && totalSpent.minor === 0n && investedTotal.minor === 0n,
  };
};
