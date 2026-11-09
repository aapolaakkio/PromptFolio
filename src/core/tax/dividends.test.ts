import { describe, expect, test } from "vitest";

import { EUR, formatMoney, parseFxRate, parseMoney, parseQuantity } from "../money.ts";
import type { IsoDate, Txn } from "../types.ts";
import { taxableDividends, totalDividendTaxable } from "./dividends.ts";

let nextId = 1;
const dividend = (o: {
  paidOn: IsoDate;
  amount: string;
  tax?: string;
  accountId?: number;
}): Txn => ({
  id: nextId++,
  accountId: o.accountId ?? 1,
  instrumentId: 7,
  type: "DIVIDEND",
  tradeDate: o.paidOn,
  quantity: parseQuantity("0"),
  unitPrice: null,
  amount: parseMoney(o.amount, EUR),
  fee: parseMoney("0", EUR),
  tax: parseMoney(o.tax ?? "0", EUR),
  currency: EUR,
  fxRateEur: parseFxRate("1", EUR),
});

const YEAR = { from: "2025-01-01", to: "2025-12-31" };
const rows = (txns: readonly Txn[], ostAccountIds: ReadonlySet<number> = new Set()) =>
  taxableDividends({ txns, ostAccountIds, ...YEAR });

describe("taxableDividends", () => {
  test("makes 85 % of the gross taxable capital income", () => {
    const [row] = rows([dividend({ paidOn: "2025-04-07", amount: "74,50", tax: "25,50" })]);

    // Cash is net of the 25,5 % withheld; the 85 % applies to the gross.
    expect(formatMoney(row!.grossEur)).toBe("100.00");
    expect(formatMoney(row!.withheldEur)).toBe("25.50");
    expect(formatMoney(row!.taxableEur)).toBe("85.00");
    expect(row!.withholdingRecorded).toBe(true);
  });

  test("says so when the ledger holds no withholding, rather than inventing one", () => {
    // No dividend records withholding (combined column); grossing up by 0.745 would be wrong for foreign shares.
    const [row] = rows([dividend({ paidOn: "2025-04-07", amount: "74,50" })]);

    expect(row!.withholdingRecorded).toBe(false);
    expect(formatMoney(row!.grossEur)).toBe("74.50");
    expect(formatMoney(row!.taxableEur)).toBe("63.33");
  });

  test("leaves an equity savings account's dividend untaxed when it is paid", () => {
    expect(
      rows([dividend({ paidOn: "2025-04-07", amount: "74,50", accountId: 7 })], new Set([7])),
    ).toEqual([]);
  });

  test("stays inside the tax year", () => {
    expect(rows([dividend({ paidOn: "2024-12-31", amount: "74,50" })])).toEqual([]);
    expect(rows([dividend({ paidOn: "2026-01-01", amount: "74,50" })])).toEqual([]);
  });

  test("totals the taxable shares, not the gross", () => {
    const year = rows([
      dividend({ paidOn: "2025-04-07", amount: "74,50", tax: "25,50" }),
      dividend({ paidOn: "2025-09-07", amount: "74,50", tax: "25,50" }),
    ]);

    expect(formatMoney(totalDividendTaxable(year))).toBe("170.00");
  });
});
