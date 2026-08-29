import { describe, expect, test } from "bun:test";

import { EUR, formatMoney, parseFxRate, parseMoney, parseQuantity } from "../money";
import type { IsoDate, TransactionType, Txn } from "../types";
import { ostReport, type OstValuation } from "./ost";

let nextId = 1;
const row = (type: TransactionType, tradeDate: IsoDate, amount: string): Txn => ({
  id: nextId++,
  accountId: 7,
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
});

const deposit = (on: IsoDate, amount: string) => row("DEPOSIT", on, amount);
const withdrawal = (on: IsoDate, amount: string) => row("WITHDRAWAL", on, `-${amount}`);
const worth =
  (value: string): (() => OstValuation) =>
  () => ({
    ok: true,
    valueEur: parseMoney(value, EUR),
  });

const YEAR = { from: "2025-01-01" as IsoDate, to: "2025-12-31" as IsoDate };

describe("ostReport", () => {
  test("reproduces vero.fi's own worked example", () => {
    // "If the account holds EUR 15,000 with EUR 5,000 profit, withdrawing
    // EUR 1,500 results in EUR 500 taxable income." Checked against the
    // authority's arithmetic rather than against our reading of the rule.
    const report = ostReport({
      txns: [deposit("2020-01-02", "10000,00"), withdrawal("2025-06-01", "1500,00")],
      valueAt: worth("15000,00"),
      ...YEAR,
    });

    const outcome = report.withdrawals[0]!.outcome;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(formatMoney(outcome.profitEur)).toBe("5000.00");
    expect(formatMoney(outcome.taxableEur)).toBe("500.00");
  });

  test("lets the capital part of a withdrawal reduce the deposits", () => {
    // 1 500 € out, of which 500 € was profit, so 1 000 € was capital returned:
    // deposits fall to 9 000 €. vero.fi ties the cap and the profit share to
    // this same reduced figure, which is why one pass computes both.
    const report = ostReport({
      txns: [deposit("2020-01-02", "10000,00"), withdrawal("2025-06-01", "1500,00")],
      valueAt: worth("15000,00"),
      ...YEAR,
    });

    expect(formatMoney(report.depositedEur)).toBe("9000.00");
    expect(formatMoney(report.capRemainingEur)).toBe("91000.00");
  });

  test("taxes nothing when the account is worth no more than what was paid in", () => {
    // An OST loss is deductible only in the year the account is closed, so a
    // withdrawal at a loss is simply not taxable income -- never a negative
    // "taxable" figure netted against something else.
    const report = ostReport({
      txns: [deposit("2020-01-02", "10000,00"), withdrawal("2025-06-01", "1000,00")],
      valueAt: worth("8000,00"),
      ...YEAR,
    });

    const outcome = report.withdrawals[0]!.outcome;
    if (!outcome.ok) throw new Error("expected a valued withdrawal");
    expect(formatMoney(outcome.profitEur)).toBe("0.00");
    expect(formatMoney(outcome.taxableEur)).toBe("0.00");
  });

  test("names the instrument when the account cannot be valued, and guesses nothing", () => {
    const report = ostReport({
      txns: [deposit("2020-01-02", "10000,00"), withdrawal("2025-06-01", "1500,00")],
      valueAt: () => ({ ok: false, instrumentId: 42 }),
      ...YEAR,
    });

    const outcome = report.withdrawals[0]!.outcome;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.instrumentId).toBe(42);
    // The split between profit and capital is unknown, so the deposits cannot
    // be advanced -- and the report says the figures are behind rather than
    // presenting a total that quietly ignores the withdrawal.
    expect(formatMoney(report.depositedEur)).toBe("10000.00");
    expect(report.incomplete).toBe(true);
  });

  test("carries earlier years' withdrawals into the state without reporting them", () => {
    // 2024 takes 1 500 € out of a 15 000 € account: 500 € profit, so deposits
    // fall to 9 000 € before 2025 is computed.
    const report = ostReport({
      txns: [
        deposit("2020-01-02", "10000,00"),
        withdrawal("2024-06-01", "1500,00"),
        withdrawal("2025-06-01", "1500,00"),
      ],
      valueAt: worth("15000,00"),
      ...YEAR,
    });

    expect(report.withdrawals).toHaveLength(1);
    expect(report.withdrawals[0]!.withdrawnOn).toBe("2025-06-01");
    const outcome = report.withdrawals[0]!.outcome;
    if (!outcome.ok) throw new Error("expected a valued withdrawal");
    // Profit is now 15 000 - 9 000 = 6 000, so the taxable share is larger
    // than the first withdrawal's despite the identical amount.
    expect(formatMoney(outcome.profitEur)).toBe("6000.00");
    expect(formatMoney(outcome.taxableEur)).toBe("600.00");
  });

  test("counts deposits toward the cap and never reports negative room", () => {
    const report = ostReport({
      txns: [deposit("2020-01-02", "100000,00"), deposit("2021-01-02", "5000,00")],
      valueAt: worth("105000,00"),
      ...YEAR,
    });

    expect(formatMoney(report.depositedEur)).toBe("105000.00");
    // Over the cap is a fact worth showing as zero room, not as a negative.
    expect(formatMoney(report.capRemainingEur)).toBe("0.00");
  });
});
