import { describe, expect, test } from "vitest";

import { EUR, parseMoney, type Currency } from "../../core/money.ts";
import type { IsoDate, TransactionType, Txn } from "../../core/types.ts";
import { SEED_RULES } from "./categories.ts";
import { categoriseWith, type SpendingRule } from "./rules.ts";
import { summariseSpending } from "./summary.ts";

// The model may not add in prose, so these pin exact figures and the two honesty rules: only money leaving counts, nothing silently left out.

let nextId = 1;
const row = (
  note: string,
  amount: string,
  tradeDate: IsoDate = "2026-03-01",
  type: TransactionType = "WITHDRAWAL",
  currency: Currency = EUR,
): Txn => ({
  id: nextId++,
  accountId: 1,
  instrumentId: null,
  type,
  tradeDate,
  quantity: { scaled: 0n },
  unitPrice: null,
  amount: parseMoney(amount, currency),
  fee: parseMoney("0", currency),
  tax: parseMoney("0", currency),
  currency,
  fxRateEur: { scaled: 100_000_000n, currency },
  note,
});

const RULES: SpendingRule[] = SEED_RULES.map((rule) => ({ ...rule, source: "seed" }));

const categorise = (note: string) => categoriseWith(note, RULES);

const YEAR = { from: "2026-01-01", to: "2026-12-31", rules: RULES } as const;

describe("categorise", () => {
  test("puts Finnish grocery chains under food", () => {
    expect(categorise("PKORTTIMAKSU — K-MARKET EXAMPLE")).toBe("groceries");
    expect(categorise("PKORTTIMAKSU — LIDL HELSINKI 4321")).toBe("groceries");
    expect(categorise("PKORTTIMAKSU — S-MARKET")).toBe("groceries");
  });

  test("separates eating out from the shopping", () => {
    expect(categorise("PKORTTIMAKSU — RAVINTOLA EXAMPLE")).toBe("restaurants");
    expect(categorise("PKORTTIMAKSU — WOLT")).toBe("restaurants");
  });

  test("leaves an unknown merchant in the reported 'other', never in a real category", () => {
    expect(categorise("PKORTTIMAKSU — JOKIN TUNTEMATON LIIKE")).toBe("other");
  });

  test("does not care how the bank capitalises a name", () => {
    expect(categorise("pkorttimaksu — k-market esimerkki")).toBe("groceries");
  });
});

describe("summariseSpending", () => {
  test("adds up one category over a period", () => {
    const summary = summariseSpending(
      [
        row("PKORTTIMAKSU — K-MARKET", "-42.15"),
        row("PKORTTIMAKSU — LIDL", "-31.20", "2026-04-02"),
        row("PKORTTIMAKSU — RAVINTOLA", "-18.50"),
      ],
      { ...YEAR, by: "category" },
    );

    const food = summary.groups.find((group) => group.key === "groceries");
    expect(food?.totalEur).toBe("-73.35");
    expect(food?.count).toBe(2);
    expect(summary.totalEur).toBe("-91.85");
  });

  test("counts only money leaving, so a salary is not negative spending", () => {
    const summary = summariseSpending(
      [
        row("PKORTTIMAKSU — K-MARKET", "-42.15"),
        row("PALKKA — EXAMPLE OYJ", "3200.00", "2026-03-05", "DEPOSIT"),
      ],
      { ...YEAR, by: "category" },
    );

    expect(summary.totalEur).toBe("-42.15");
    expect(summary.groups.some((group) => group.key === "salary")).toBe(false);
  });

  test("stays inside the asked period", () => {
    const txns = [
      row("PKORTTIMAKSU — K-MARKET", "-42.15", "2025-12-31"),
      row("PKORTTIMAKSU — K-MARKET", "-10.00", "2026-03-01"),
      row("PKORTTIMAKSU — K-MARKET", "-99.00", "2027-01-01"),
    ];
    expect(summariseSpending(txns, { ...YEAR, by: "category" }).totalEur).toBe("-10.00");
  });

  test("reports what it could not classify, as a share of the total", () => {
    const summary = summariseSpending(
      [row("PKORTTIMAKSU — K-MARKET", "-50.00"), row("PKORTTIMAKSU — TUNTEMATON", "-50.00")],
      { ...YEAR, by: "category" },
    );

    expect(summary.uncategorisedShare).toBeCloseTo(0.5, 10);
  });

  test("groups by counterparty when asked, largest first", () => {
    const summary = summariseSpending(
      [
        row("PKORTTIMAKSU — K-MARKET", "-42.15"),
        row("PKORTTIMAKSU — K-MARKET", "-17.85"),
        row("PKORTTIMAKSU — LIDL", "-31.20"),
      ],
      { ...YEAR, by: "counterparty" },
    );

    expect(summary.groups[0]?.label).toBe("K-MARKET");
    expect(summary.groups[0]?.totalEur).toBe("-60.00");
    expect(summary.groups[1]?.label).toBe("LIDL");
  });

  test("folds the tail into one row rather than dropping it, so the parts still add up", () => {
    const summary = summariseSpending(
      [
        row("PKORTTIMAKSU — K-MARKET", "-50.00"),
        row("PKORTTIMAKSU — LIDL", "-30.00"),
        row("PKORTTIMAKSU — PRISMA", "-20.00"),
      ],
      { ...YEAR, by: "counterparty", limit: 1 },
    );

    expect(summary.groups).toHaveLength(2);
    expect(summary.groups[1]?.key).toBe("muut");
    expect(summary.groups[1]?.totalEur).toBe("-50.00");
    expect(summary.groups[1]?.count).toBe(2);
  });

  test("is zero, not a crash, when nothing was spent", () => {
    const summary = summariseSpending([], { ...YEAR, by: "category" });
    expect(summary.totalEur).toBe("0.00");
    expect(summary.groups).toEqual([]);
    expect(summary.uncategorisedShare).toBe(0);
  });

  test("ignores a row with no note rather than inventing a category for it", () => {
    const summary = summariseSpending([row("", "-10.00")], { ...YEAR, by: "category" });
    expect(summary.groups[0]?.key).toBe("other");
    expect(summary.uncategorisedShare).toBeCloseTo(1, 10);
  });
});

describe("the widened category rules", () => {
  test("recognise the shops a Finnish statement actually names", () => {
    expect(categorise("PKORTTIMAKSU — K-CITYMARKET TURKU")).toBe("groceries");
    expect(categorise("PKORTTIMAKSU — KOTIPIZZA SALO")).toBe("restaurants");
    expect(categorise("PKORTTIMAKSU — EASYPARK")).toBe("transport");
    expect(categorise("PKORTTIMAKSU — GIGANTTI")).toBe("online-shopping");
    expect(categorise("PKORTTIMAKSU — H&M HELSINKI")).toBe("clothing");
    expect(categorise("PKORTTIMAKSU — MUSTI JA MIRRI")).toBe("pets");
    expect(categorise("PKORTTIMAKSU — SCANDIC")).toBe("travel");
    expect(categorise("MAKSUPALVELU — SPOTIFY")).toBe("subscriptions");
    expect(categorise("MAKSUPALVELU — VEROHALLINTO")).toBe("taxes");
    expect(categorise("PKORTTIMAKSU — K-RAUTA")).toBe("home");
  });

  test("keep a loan repayment apart from a bank's service fee", () => {
    // Most of a repayment is the owner's own money; only the interest is a cost.
    expect(categorise("LUOTON MAKSU — PANKKI OYJ")).toBe("loans");
    expect(categorise("LAINANHOITO")).toBe("loans");
    expect(categorise("PALVELUMAKSU")).toBe("bank-fees");
  });

  test("still leave a shop nobody wrote a rule for in Other", () => {
    expect(categorise("PKORTTIMAKSU — PIENI PUOTI 12345")).toBe("other");
  });

  test("keep eating out apart from the weekly shop", () => {
    expect(categorise("PKORTTIMAKSU — RAVINTOLA PRISMA")).toBe("restaurants");
  });
});

describe("rows that are not spending", () => {
  test("an opening balance is left out, however negative", () => {
    const summary = summariseSpending(
      [
        row("Opening balance, derived from balance", "-1200.00", "2026-03-01", "OPENING_BALANCE"),
        row("PKORTTIMAKSU — K-MARKET", "-42.15"),
      ],
      { ...YEAR, by: "category" },
    );

    expect(summary.totalEur).toBe("-42.15");
    expect(summary.groups).toHaveLength(1);
  });
});
