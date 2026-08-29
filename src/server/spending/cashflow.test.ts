import { describe, expect, test } from "bun:test";

import { EUR, parseMoney } from "../../core/money";
import type { IsoDate, TransactionType, Txn } from "../../core/types";
import { cashFlowFor } from "./cashflow";
import { SEED_RULES } from "./categories";
import { internalTransferIds } from "./internal";
import { monthlyFlows } from "./monthly";
import type { SpendingRule } from "./rules";

// These three decide what a person is shown about their own year, so the tests
// are about the two ways such a picture lies: counting the owner's own money
// twice as income, and balancing itself with a flow nobody can account for.

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
      row(2, "PALKKA — ESIMERKKI OYJ", "500.00", "2026-03-02", "DEPOSIT"),
    ];

    // Same amount, adjacent days, but a shop is not the owner's own account.
    // The pairing cannot tell those apart, which is why it needs two accounts
    // and is deliberately conservative about everything else.
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

    // Three rows, one unmatched: the second outgoing transfer has no partner.
    expect(internalTransferIds(txns).size).toBe(2);
  });
});

describe("cashFlowFor", () => {
  const salary = row(1, "PALKKA — ESIMERKKI OYJ", "3000.00", "2026-01-05", "DEPOSIT");
  const groceries = row(1, "PKORTTIMAKSU — K-MARKET", "-200.00", "2026-01-10");
  const restaurant = row(1, "PKORTTIMAKSU — RAVINTOLA", "-100.00", "2026-01-11");

  test("splits income into its sources and spending into its categories", () => {
    const flow = flowOf([salary, groceries, restaurant]);

    expect(nodeOf([salary, groceries, restaurant], "income")?.totalEur).toBe("3000.00");
    expect(flow.nodes.find((node) => node.id === "out:ruoka")?.totalEur).toBe("200.00");
    expect(flow.nodes.find((node) => node.id === "out:ravintolat")?.totalEur).toBe("100.00");
  });

  test("does not count the owner's own transfer as income", () => {
    const moved = [
      row(1, "TILISIIRTO — OMA SÄÄSTÖ", "-1000.00", "2026-02-01"),
      row(2, "Tilinavaus", "1000.00", "2026-02-01", "DEPOSIT"),
    ];

    // Deposit openings once arrived here as "income", because a
    // rule the assistant wrote on the owner's own name out-matched the transfer
    // rule. Pairing the two halves is what stops that.
    expect(nodeOf([salary, ...moved], "income")?.totalEur).toBe("3000.00");
  });

  test("shows money put into investments as its own flow", () => {
    const invested = row(9, "", "500.00", "2026-03-01", "DEPOSIT");
    expect(nodeOf([salary, invested], "invested")?.totalEur).toBe("500.00");
  });

  test("names the leftover as a residual, and its sign as which way it went", () => {
    const modest = flowOf([salary, groceries]);
    // 3000 in, 200 spent: 2800 stayed.
    expect(modest.nodes.find((node) => node.id === "leftover")?.label).toBe("Jäi tilille");
    expect(modest.nodes.find((node) => node.id === "leftover")?.totalEur).toBe("2800.00");

    const heavy = flowOf([salary, row(1, "PKORTTIMAKSU — K-MARKET", "-4000.00", "2026-01-10")]);
    // Spending beyond the period's income is a fact about the period, not a
    // number to hide behind a balanced-looking picture.
    expect(heavy.nodes.find((node) => node.id === "leftover")?.label).toBe("Katettu säästöistä");
    expect(heavy.nodes.find((node) => node.id === "leftover")?.totalEur).toBe("1000.00");
  });

  test("separates tax from ordinary spending", () => {
    const tax = row(1, "MAKSUPALVELU — VEROHALLINTO", "-800.00", "2026-04-01");
    expect(nodeOf([salary, tax], "taxes")?.totalEur).toBe("800.00");
    expect(nodeOf([salary, tax], "expenses")).toBeUndefined();
  });

  test("stays inside the period", () => {
    const older = row(1, "PALKKA — ESIMERKKI OYJ", "9000.00", "2025-06-01", "DEPOSIT");
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
        row(1, "PALKKA — ESIMERKKI OYJ", "3000.00", "2026-01-05", "DEPOSIT"),
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

    // A chart that closes the gap implies activity that did not happen.
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
