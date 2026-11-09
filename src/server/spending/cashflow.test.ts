import { describe, expect, test } from "vitest";

import { EUR, parseMoney } from "../../core/money.ts";
import type { IsoDate, TransactionType, Txn } from "../../core/types.ts";
import { cashFlowFor } from "./cashflow.ts";
import { SEED_RULES } from "./categories.ts";
import { internalTransferIds, investmentPaymentIds, notSpendingIds } from "./internal.ts";
import { monthlyByCategory, monthlyFlows } from "./monthly.ts";
import type { SpendingRule } from "./rules.ts";

// The picture must not lie in two ways: counting the owner's own money twice as income, and balancing itself with an unexplained flow.

const RULES: SpendingRule[] = SEED_RULES.map((rule) => ({ ...rule, source: "seed" }));

let nextId = 1;
const row = (
  accountId: number,
  note: string,
  amount: string,
  tradeDate: IsoDate,
  type: TransactionType = "WITHDRAWAL",
): Txn => ({
  id: nextId++,
  accountId,
  instrumentId: null,
  type,
  tradeDate,
  quantity: { scaled: 0n },
  unitPrice: null,
  amount: parseMoney(amount, EUR),
  fee: parseMoney("0", EUR),
  tax: parseMoney("0", EUR),
  currency: EUR,
  fxRateEur: { scaled: 100_000_000n, currency: EUR },
  note,
});

const BANK = new Set([1, 2]);
const BROKERAGE = new Set([9]);
const YEAR = { from: "2026-01-01", to: "2026-12-31" } as const;

const flowOf = (txns: readonly Txn[]) =>
  cashFlowFor({
    txns,
    rules: RULES,
    bankAccountIds: BANK,
    investedAccountIds: BROKERAGE,
    ...YEAR,
  });

const nodeOf = (txns: readonly Txn[], id: string) =>
  flowOf(txns).nodes.find((node) => node.id === id);

describe("internalTransferIds", () => {
  test("pairs money leaving one own account with money arriving in another", () => {
    const txns = [
      row(1, "TILISIIRTO — OMA SÄÄSTÖ", "-500.00", "2026-03-01"),
      row(2, "Tilinavaus", "500.00", "2026-03-02", "DEPOSIT"),
    ];

    expect(internalTransferIds(txns).size).toBe(2);
  });

  test("leaves a payment out to someone else alone", () => {
    const txns = [
      row(1, "PKORTTIMAKSU — K-MARKET", "-500.00", "2026-03-01"),
      row(2, "PALKKA — EXAMPLE OYJ", "500.00", "2026-03-02", "DEPOSIT"),
    ];

    // A shop is not the owner's own account; the pairing needs two accounts and is conservative about the rest.
    expect(internalTransferIds(txns).size).toBe(2);
  });

  test("refuses to pair rows that are too far apart in time", () => {
    const txns = [
      row(1, "TILISIIRTO", "-500.00", "2026-03-01"),
      row(2, "Tilinavaus", "500.00", "2026-04-15", "DEPOSIT"),
    ];

    expect(internalTransferIds(txns).size).toBe(0);
  });

  test("uses each row once, so two identical transfers pair off in twos", () => {
    const txns = [
      row(1, "TILISIIRTO", "-500.00", "2026-03-01"),
      row(1, "TILISIIRTO", "-500.00", "2026-03-01"),
      row(2, "Tilinavaus", "500.00", "2026-03-01", "DEPOSIT"),
    ];

    expect(internalTransferIds(txns).size).toBe(2);
  });
});

describe("notSpendingIds", () => {
  // By-category and by-payee lists must apply the same exclusions as the Sankey (a card bill is not spending).
  test("covers the owner's own transfers as well as investment payments", () => {
    const txns = [
      row(1, "LUOTON MAKSU — OP KORTTI", "-450.00", "2026-04-01"),
      row(2, "MAKSU", "450.00", "2026-04-01", "DEPOSIT"),
      row(1, "PKORTTIMAKSU — K-MARKET", "-30.00", "2026-04-02"),
    ];

    const moved = notSpendingIds(txns, BANK);

    expect(moved.has(txns[0]!.id)).toBe(true);
    expect(moved.has(txns[1]!.id)).toBe(true);
    expect(moved.has(txns[2]!.id)).toBe(false);
  });
});

describe("cashFlowFor", () => {
  const salary = row(1, "PALKKA — EXAMPLE OYJ", "3000.00", "2026-01-05", "DEPOSIT");
  const groceries = row(1, "PKORTTIMAKSU — K-MARKET", "-200.00", "2026-01-10");
  const restaurant = row(1, "PKORTTIMAKSU — RAVINTOLA", "-100.00", "2026-01-11");

  test("splits income into its sources and spending into its categories", () => {
    const flow = flowOf([salary, groceries, restaurant]);

    expect(nodeOf([salary, groceries, restaurant], "income")?.totalEur).toBe("3000.00");
    expect(flow.nodes.find((node) => node.id === "out:groceries")?.totalEur).toBe("200.00");
    expect(flow.nodes.find((node) => node.id === "out:restaurants")?.totalEur).toBe("100.00");
  });

  test("never links to a category the refunds cancelled out", () => {
    // A refund larger than the period's purchases gives a non-positive total, which cannot be a node (the diagram threw on the link).
    const flow = flowOf([
      salary,
      row(1, "PKORTTIMAKSU — RAVINTOLA", "-20.00", "2026-01-11"),
      row(1, "HYVITYS — RAVINTOLA", "20.00", "2026-01-12", "DEPOSIT"),
    ]);

    const keys = new Set(flow.nodes.map((node) => node.id));
    for (const link of flow.links) {
      expect(keys.has(link.from)).toBe(true);
      expect(keys.has(link.to)).toBe(true);
    }
    expect(keys.has("out:restaurants")).toBe(false);
  });

  test("does not count the owner's own transfer as income", () => {
    const moved = [
      row(1, "TILISIIRTO — OMA SÄÄSTÖ", "-1000.00", "2026-02-01"),
      row(2, "Tilinavaus", "1000.00", "2026-02-01", "DEPOSIT"),
    ];

    // A rule on the owner's own name once out-matched the transfer rule and turned deposits into income; pairing prevents it.
    expect(nodeOf([salary, ...moved], "income")?.totalEur).toBe("3000.00");
  });

  test("shows money put into investments as its own flow", () => {
    const invested = row(9, "", "500.00", "2026-03-01", "DEPOSIT");
    expect(nodeOf([salary, invested], "invested")?.totalEur).toBe("500.00");
  });

  test("names the leftover as a residual, and its sign as which way it went", () => {
    const modest = flowOf([salary, groceries]);
    expect(modest.nodes.find((node) => node.id === "leftover")?.label).toBe("Left in account");
    expect(modest.nodes.find((node) => node.id === "leftover")?.totalEur).toBe("2800.00");

    const heavy = flowOf([salary, row(1, "PKORTTIMAKSU — K-MARKET", "-4000.00", "2026-01-10")]);
    // Spending beyond income is a fact about the period; the picture must not hide it.
    expect(heavy.nodes.find((node) => node.id === "leftover")?.label).toBe("Covered from savings");
    expect(heavy.nodes.find((node) => node.id === "leftover")?.totalEur).toBe("1000.00");
  });

  test("separates tax from ordinary spending", () => {
    const tax = row(1, "MAKSUPALVELU — VEROHALLINTO", "-800.00", "2026-04-01");
    expect(nodeOf([salary, tax], "taxes")?.totalEur).toBe("800.00");
    expect(nodeOf([salary, tax], "expenses")).toBeUndefined();
  });

  test("stays inside the period", () => {
    const older = row(1, "PALKKA — EXAMPLE OYJ", "9000.00", "2025-06-01", "DEPOSIT");
    expect(nodeOf([salary, older], "income")?.totalEur).toBe("3000.00");
  });

  test("says when there is nothing to draw", () => {
    expect(flowOf([]).empty).toBe(true);
    expect(flowOf([salary]).empty).toBe(false);
  });

  test("every link's endpoints exist, which the chart requires", () => {
    const flow = flowOf([
      salary,
      groceries,
      restaurant,
      row(9, "", "500.00", "2026-03-01", "DEPOSIT"),
    ]);
    const ids = new Set(flow.nodes.map((node) => node.id));

    for (const link of flow.links) {
      expect(ids.has(link.from)).toBe(true);
      expect(ids.has(link.to)).toBe(true);
    }
  });
});

describe("monthlyFlows", () => {
  test("totals each month's income and spending separately", () => {
    const months = monthlyFlows({
      txns: [
        row(1, "PALKKA — EXAMPLE OYJ", "3000.00", "2026-01-05", "DEPOSIT"),
        row(1, "PKORTTIMAKSU — K-MARKET", "-200.00", "2026-01-10"),
        row(1, "PKORTTIMAKSU — K-MARKET", "-150.00", "2026-02-10"),
      ],
      rules: RULES,
      bankAccountIds: BANK,
      from: "2026-01-01",
      to: "2026-02-28",
    });

    expect(months).toHaveLength(2);
    expect(months[0]).toEqual({
      month: "2026-01",
      incomeEur: "3000.00",
      expensesEur: "200.00",
      netEur: "2800.00",
    });
    expect(months[1]?.netEur).toBe("-150.00");
  });

  test("returns a quiet month rather than skipping it", () => {
    const months = monthlyFlows({
      txns: [row(1, "PKORTTIMAKSU — K-MARKET", "-10.00", "2026-03-10")],
      rules: RULES,
      bankAccountIds: BANK,
      from: "2026-01-01",
      to: "2026-03-31",
    });

    expect(months.map((month) => month.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(months[0]?.incomeEur).toBe("0.00");
  });

  test("leaves the owner's own transfers out of both sides", () => {
    const months = monthlyFlows({
      txns: [
        row(1, "TILISIIRTO — OMA SÄÄSTÖ", "-1000.00", "2026-01-05"),
        row(2, "Tilinavaus", "1000.00", "2026-01-05", "DEPOSIT"),
      ],
      rules: RULES,
      bankAccountIds: BANK,
      from: "2026-01-01",
      to: "2026-01-31",
    });

    expect(months[0]).toEqual({
      month: "2026-01",
      incomeEur: "0.00",
      expensesEur: "0.00",
      netEur: "0.00",
    });
  });
});

describe("payments that are really investments", () => {
  // A fund saving leaves the bank as a payment and lands at the broker as a purchase (OP's export records no cash); both halves are negative.
  const saving = row(1, "SÄÄNN.SÄÄST. — RAHASTO", "-250.00", "2026-03-01");
  const purchase = row(9, "", "-250.00", "2026-03-02", "BUY");
  const CASHLESS = new Set([9]);

  test("are recognised by the purchase they funded", () => {
    expect(investmentPaymentIds([saving, purchase], CASHLESS, BANK).has(saving.id)).toBe(true);
  });

  test("are not matched when the broker records its own cash", () => {
    // A broker-side deposit is the better half; this rule would double it.
    expect(investmentPaymentIds([saving, purchase], new Set(), BANK).size).toBe(0);
  });

  test("are not matched to a purchase of a different size", () => {
    const other = row(9, "", "-100.00", "2026-03-02", "BUY");
    expect(investmentPaymentIds([saving, other], CASHLESS, BANK).size).toBe(0);
  });

  test("count as investing rather than as spending", () => {
    const flow = cashFlowFor({
      txns: [row(1, "PALKKA — EXAMPLE OYJ", "3000.00", "2026-01-05", "DEPOSIT"), saving, purchase],
      rules: RULES,
      bankAccountIds: BANK,
      investedAccountIds: new Set([9]),
      cashlessInvestedAccountIds: CASHLESS,
      ...YEAR,
    });

    expect(flow.nodes.find((node) => node.id === "invested")?.totalEur).toBe("250.00");
    expect(flow.nodes.find((node) => node.id === "expenses")).toBeUndefined();
  });
});

describe("an opening balance", () => {
  test("is not spending, however negative it is", () => {
    const opening = row(
      1,
      "Opening balance, derived from balance",
      "-1200.00",
      "2026-01-01",
      "OPENING_BALANCE",
    );
    const flow = flowOf([
      row(1, "PALKKA — EXAMPLE OYJ", "3000.00", "2026-01-05", "DEPOSIT"),
      opening,
      row(1, "PKORTTIMAKSU — K-MARKET", "-200.00", "2026-01-10"),
    ]);

    // A derived opening balance was once reported as the largest expense.
    expect(flow.nodes.find((node) => node.id === "expenses")?.totalEur).toBe("200.00");
  });
});

describe("monthlyByCategory", () => {
  const label = (key: string) => key.toUpperCase();
  const args = {
    rules: RULES,
    bankAccountIds: BANK,
    labelFor: label,
    from: "2026-01-01",
    to: "2026-02-28",
  };

  test("splits each month's spending by category", () => {
    const report = monthlyByCategory({
      txns: [
        row(1, "PKORTTIMAKSU — K-MARKET", "-200.00", "2026-01-10"),
        row(1, "PKORTTIMAKSU — RAVINTOLA", "-100.00", "2026-01-11"),
        row(1, "PKORTTIMAKSU — K-MARKET", "-150.00", "2026-02-10"),
      ],
      ...args,
    });

    expect(report.months.map((month) => month.month)).toEqual(["2026-01", "2026-02"]);
    expect(report.months[0]!.byCategory.groceries).toBe("200.00");
    expect(report.months[1]!.byCategory.restaurants).toBe("0.00");
  });

  test("gives every category a figure every month, so a stack has no holes", () => {
    // A vanishing band reads as missing data, not a month of zero.
    const report = monthlyByCategory({
      txns: [row(1, "PKORTTIMAKSU — RAVINTOLA", "-100.00", "2026-01-11")],
      ...args,
    });

    expect(Object.keys(report.months[1]!.byCategory)).toEqual(
      report.categories.map((category) => category.key),
    );
  });

  test("orders categories by their whole-period total, so colours stay put", () => {
    // Ordering by the current month would repaint the bands as the reader scrolls.
    const report = monthlyByCategory({
      txns: [
        row(1, "PKORTTIMAKSU — RAVINTOLA", "-500.00", "2026-01-11"),
        row(1, "PKORTTIMAKSU — K-MARKET", "-100.00", "2026-01-10"),
        row(1, "PKORTTIMAKSU — K-MARKET", "-900.00", "2026-02-10"),
      ],
      ...args,
    });

    expect(report.categories.map((category) => category.key)).toEqual(["groceries", "restaurants"]);
    expect(report.categories[0]!.label).toBe("GROCERIES");
  });

  test("leaves out what is not spending", () => {
    const report = monthlyByCategory({
      txns: [
        row(1, "PALKKA — EXAMPLE OYJ", "3000.00", "2026-01-05", "DEPOSIT"),
        row(1, "Opening balance", "-1200.00", "2026-01-01", "OPENING_BALANCE"),
        row(1, "TILISIIRTO — OMA SÄÄSTÖ", "-500.00", "2026-01-06"),
        row(2, "Tilinavaus", "500.00", "2026-01-06", "DEPOSIT"),
      ],
      ...args,
    });

    // Income, an opening balance and own-account transfers are not spending.
    expect(report.categories).toEqual([]);
  });
});

test("a nonsense start date does not ask for twenty thousand months", () => {
  // A date field mid-typing ("0006-08-06") must not produce a range no chart can draw.
  const months = monthlyFlows({
    txns: [row(1, "PKORTTIMAKSU — K-MARKET", "-10.00", "2026-03-10")],
    rules: RULES,
    bankAccountIds: BANK,
    from: "0006-01-01",
    to: "2026-12-31",
  });

  expect(months.length).toBeLessThanOrEqual(600);
  expect(months.at(-1)?.month).toBe("2026-12");
});

describe("a credit card bill", () => {
  // The card's purchases are the spending; the bill settling them is an own-account movement and would count the month twice.
  const CARD = 3;

  test("cancels against the payment from the current account", () => {
    const settlement = row(CARD, "Suoritus", "456.11", "2026-06-25", "DEPOSIT");
    const payment = row(1, "LUOTON MAKSU", "-456.11", "2026-06-24");

    expect(internalTransferIds([settlement, payment]).size).toBe(2);
  });

  test("leaves the purchases themselves alone", () => {
    const purchase = row(CARD, "PKORTTIMAKSU — K-MARKET", "-200.00", "2026-06-10");
    const settlement = row(CARD, "Suoritus", "456.11", "2026-06-25", "DEPOSIT");
    const payment = row(1, "LUOTON MAKSU", "-456.11", "2026-06-24");

    const internal = internalTransferIds([purchase, settlement, payment]);
    expect(internal.has(purchase.id)).toBe(false);
  });

  test("so the month's spending is the purchases, not the purchases plus the bill", () => {
    const flow = cashFlowFor({
      txns: [
        row(1, "PALKKA — EXAMPLE OYJ", "3000.00", "2026-06-01", "DEPOSIT"),
        row(CARD, "PKORTTIMAKSU — K-MARKET", "-200.00", "2026-06-10"),
        row(CARD, "Suoritus", "200.00", "2026-06-25", "DEPOSIT"),
        row(1, "LUOTON MAKSU", "-200.00", "2026-06-24"),
      ],
      rules: RULES,
      bankAccountIds: new Set([1, 2, CARD]),
      investedAccountIds: BROKERAGE,
      ...YEAR,
    });

    // 200 spent once, in the shop's category: not 400, and not 200 under whatever "LUOTON MAKSU" matches.
    expect(flow.nodes.find((node) => node.id === "out:groceries")?.totalEur).toBe("200.00");
    expect(flow.nodes.find((node) => node.id === "expenses")?.totalEur).toBe("200.00");
  });
});

describe("a card refund", () => {
  const CARD = 3;
  const BANKS = new Set([1, 2, CARD]);

  test("comes off the category it was spent in, rather than counting as income", () => {
    // Not income: that would inflate what came in and leave the reversed purchase at full price.
    const flow = cashFlowFor({
      txns: [
        row(1, "PALKKA — EXAMPLE OYJ", "3000.00", "2026-02-01", "DEPOSIT"),
        row(CARD, "PKORTTIMAKSU — RAVINTOLA", "-20.00", "2026-02-05"),
        row(CARD, "Hyvitys — RAVINTOLA", "4.49", "2026-02-06", "DEPOSIT"),
      ],
      rules: RULES,
      bankAccountIds: BANKS,
      investedAccountIds: BROKERAGE,
      from: "2026-01-01",
      to: "2026-12-31",
    });

    expect(flow.nodes.find((node) => node.id === "income")?.totalEur).toBe("3000.00");
    expect(flow.nodes.find((node) => node.id === "out:restaurants")?.totalEur).toBe("15.51");
  });

  test("lowers the month's spending instead of raising its income", () => {
    const months = monthlyFlows({
      txns: [
        row(CARD, "PKORTTIMAKSU — RAVINTOLA", "-20.00", "2026-02-05"),
        row(CARD, "Hyvitys — RAVINTOLA", "4.49", "2026-02-06", "DEPOSIT"),
      ],
      rules: RULES,
      bankAccountIds: BANKS,
      from: "2026-02-01",
      to: "2026-02-28",
    });

    expect(months[0]).toEqual({
      month: "2026-02",
      incomeEur: "0.00",
      expensesEur: "15.51",
      netEur: "-15.51",
    });
  });

  test("a card's own charges are spending like any other", () => {
    // Interest and a maintenance fee arrive negative, so they are costs.
    const months = monthlyFlows({
      txns: [
        row(CARD, "Korko", "-1.40", "2026-02-24"),
        row(CARD, "Tilinhoitomaksu", "-3.50", "2026-02-24"),
      ],
      rules: RULES,
      bankAccountIds: BANKS,
      from: "2026-02-01",
      to: "2026-02-28",
    });

    expect(months[0]?.expensesEur).toBe("4.90");
  });
});

describe("cashFlowFor, split by payee", () => {
  const byPayee = (txns: readonly Txn[]) =>
    cashFlowFor({
      txns,
      rules: RULES,
      bankAccountIds: BANK,
      investedAccountIds: BROKERAGE,
      ...YEAR,
      by: "counterparty",
    });

  test("names each payee where the category split names each category", () => {
    const flow = byPayee([
      row(1, "PKORTTIMAKSU — K-MARKET EXAMPLE", "-40.00", "2026-03-01"),
      row(1, "PKORTTIMAKSU — K-MARKET EXAMPLE", "-10.00", "2026-03-02"),
      row(1, "PKORTTIMAKSU — EXAMPLE RAVINTOLA", "-25.00", "2026-03-03"),
    ]);
    const out = flow.nodes.filter((node) => node.id.startsWith("out:"));
    expect(out.map((node) => [node.label, node.totalEur])).toEqual([
      ["K-MARKET EXAMPLE", "50.00"],
      ["EXAMPLE RAVINTOLA", "25.00"],
    ]);
  });

  test("past the fifteen largest payees, the rest are added up into one node", () => {
    const flow = byPayee(
      Array.from({ length: 18 }, (_, i) =>
        row(1, `PKORTTIMAKSU — KAUPPA ${i}`, `-${100 - i}.00`, "2026-04-01"),
      ),
    );
    const out = flow.nodes.filter((node) => node.id.startsWith("out:"));
    expect(out).toHaveLength(16);
    expect(out.at(-1)).toMatchObject({ label: "Other payees", totalEur: "252.00" });
  });
});
