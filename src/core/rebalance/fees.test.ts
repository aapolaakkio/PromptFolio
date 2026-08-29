import { describe, expect, test } from "bun:test";

import { EUR, formatMoney, parseFxRate, parseMoney, parseQuantity } from "../money";
import type { IsoDate, TransactionType, Txn } from "../types";
import { feesByYear } from "./fees";

let nextId = 1;
const txn = (
  type: TransactionType,
  tradeDate: IsoDate,
  o: { amount?: string; fee?: string; accountId?: number } = {},
): Txn => ({
  id: nextId++,
  accountId: o.accountId ?? 1,
  instrumentId: null,
  type,
  tradeDate,
  quantity: parseQuantity("0"),
  unitPrice: null,
  amount: parseMoney(o.amount ?? "0", EUR),
  fee: parseMoney(o.fee ?? "0", EUR),
  tax: parseMoney("0", EUR),
  currency: EUR,
  fxRateEur: parseFxRate("1", EUR),
});

describe("feesByYear", () => {
  test("counts a trade's commission and a charged fee separately", () => {
    const [year] = feesByYear({
      txns: [
        txn("BUY", "2025-03-10", { amount: "-1000,00", fee: "15,00" }),
        txn("FEE", "2025-04-01", { amount: "-2,50" }),
      ],
      ostAccountIds: new Set(),
    });

    expect(formatMoney(year!.tradeFeesEur)).toBe("15.00");
    expect(formatMoney(year!.chargedFeesEur)).toBe("2.50");
    expect(formatMoney(year!.totalEur)).toBe("17.50");
  });

  test("capital income tax withheld on an equity savings account is not a fee", () => {
    // The broker books it as a fee row, for a good reason -- the money leaves
    // permanently without reaching the investor -- but it is tax on a gain, not
    // a cost of investing. In a real ledger it is most of the fee total in the
    // years it appears, so counting it makes fee drag meaningless.
    const [year] = feesByYear({
      txns: [txn("FEE", "2025-10-21", { amount: "-30,00", accountId: 7 })],
      ostAccountIds: new Set([7]),
    });

    expect(formatMoney(year!.totalEur)).toBe("0.00");
    // Reported, under its own name: the figure is worth seeing.
    expect(formatMoney(year!.withheldTaxEur)).toBe("30.00");
  });

  test("an ordinary fee on an ordinary account is still a fee", () => {
    const [year] = feesByYear({
      txns: [txn("FEE", "2025-04-01", { amount: "-2,50", accountId: 1 })],
      ostAccountIds: new Set([7]),
    });

    expect(formatMoney(year!.chargedFeesEur)).toBe("2.50");
    expect(formatMoney(year!.withheldTaxEur)).toBe("0.00");
  });

  test("counts a commission on a sale as well as on a purchase", () => {
    const [year] = feesByYear({
      txns: [txn("SELL", "2025-06-01", { amount: "985,00", fee: "15,00" })],
      ostAccountIds: new Set(),
    });

    expect(formatMoney(year!.tradeFeesEur)).toBe("15.00");
  });

  test("reports years newest first and leaves out a year that cost nothing", () => {
    const years = feesByYear({
      txns: [
        txn("BUY", "2024-03-10", { amount: "-1000,00", fee: "15,00" }),
        txn("BUY", "2023-03-10", { amount: "-1000,00" }),
        txn("BUY", "2025-03-10", { amount: "-1000,00", fee: "9,00" }),
      ],
      ostAccountIds: new Set(),
    });

    expect(years.map((y) => y.year)).toEqual([2025, 2024]);
  });
});
