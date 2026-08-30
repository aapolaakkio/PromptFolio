import { describe, expect, test } from "vitest";

import { EUR, parseFxRate, parseMoney, parseQuantity } from "../../core/money.ts";
import type { IsoDate, TransactionType, Txn } from "../../core/types.ts";
import { SEED_RULES } from "./categories.ts";
import type { SpendingRule } from "./rules.ts";
import { classifiedTransactions } from "./transactions.ts";

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
  quantity: parseQuantity("0"),
  unitPrice: null,
  amount: parseMoney(amount, EUR),
  fee: parseMoney("0", EUR),
  tax: parseMoney("0", EUR),
  currency: EUR,
  fxRateEur: parseFxRate("1", EUR),
  note,
});

const BANK = new Set([1, 2]);
const classify = (txns: readonly Txn[]) =>
  classifiedTransactions({
    txns,
    rules: RULES,
    bankAccountIds: BANK,
    cashlessAccountIds: new Set([9]),
    labelFor: (category) => category.toUpperCase(),
    from: "2026-01-01",
    to: "2026-12-31",
  });

describe("classifiedTransactions", () => {
  test("gives every row the class the rules gave it", () => {
    const [groceries] = classify([row(1, "PKORTTIMAKSU — K-MARKET", "-200.00", "2026-01-10")]);

    expect(groceries?.category).toBe("ruoka");
    expect(groceries?.categoryLabel).toBe("RUOKA");
    expect(groceries?.counted).toBe(true);
    expect(groceries?.excludedReason).toBeNull();
  });

  test("shows why a row is not spending rather than leaving it out", () => {
    // The totals apply these exclusions silently; a ledger that also hid the
    // rows would leave the reader unable to check any figure against anything.
    const rows = classify([
      row(1, "PALKKA — ESIMERKKI OYJ", "3000.00", "2026-01-05", "DEPOSIT"),
      row(1, "Alkusaldo", "-1200.00", "2026-01-01", "OPENING_BALANCE"),
    ]);

    expect(rows.find((entry) => entry.text.startsWith("PALKKA"))?.excludedReason).toBe("income");
    expect(rows.find((entry) => entry.text === "Alkusaldo")?.excludedReason).toBe(
      "opening-balance",
    );
    expect(rows.every((entry) => !entry.counted)).toBe(true);
  });

  test("names a transfer between the owner's own accounts as one", () => {
    const rows = classify([
      row(1, "TILISIIRTO — OMA SÄÄSTÖ", "-500.00", "2026-03-01"),
      row(2, "Tilinavaus", "500.00", "2026-03-02", "DEPOSIT"),
    ]);

    expect(rows.every((entry) => entry.excludedReason === "internal-transfer")).toBe(true);
  });

  test("names a payment that funded a fund purchase as investing", () => {
    const rows = classify([
      row(1, "SÄÄNN.SÄÄST. — RAHASTO", "-250.00", "2026-03-01"),
      row(9, "", "-250.00", "2026-03-02", "BUY"),
    ]);

    expect(rows[0]?.excludedReason).toBe("investment");
  });

  test("leaves out anything that is not a bank account, and anything outside the period", () => {
    const rows = classify([
      row(9, "OSTO", "-250.00", "2026-03-01"),
      row(1, "PKORTTIMAKSU — K-MARKET", "-200.00", "2025-12-31"),
    ]);

    expect(rows).toEqual([]);
  });

  test("puts the newest first, which is where a reader starts", () => {
    const rows = classify([
      row(1, "PKORTTIMAKSU — K-MARKET", "-10.00", "2026-01-10"),
      row(1, "PKORTTIMAKSU — K-MARKET", "-20.00", "2026-05-10"),
    ]);

    expect(rows.map((entry) => entry.date)).toEqual(["2026-05-10", "2026-01-10"]);
  });
});
