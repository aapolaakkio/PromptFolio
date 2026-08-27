import { test, expect } from "bun:test";
import { buildLots, costBasisAt } from "./costbasis";
import type { Txn, TransactionType } from "./types";
import {
  parseMoney,
  parseQuantity,
  parseFxRate,
  formatMoney,
  formatQuantity,
  addMoney,
  zeroMoney,
} from "./money";

let nextId = 1;
const txn = (
  type: TransactionType,
  tradeDate: string,
  o: { qty?: string; amount?: string; fee?: string; currency?: "EUR" | "USD"; rate?: string } = {},
): Txn => ({
  id: nextId++,
  accountId: 1,
  instrumentId: 7,
  type,
  tradeDate,
  quantity: parseQuantity(o.qty ?? "0"),
  unitPrice: null,
  amount: parseMoney(o.amount ?? "0", o.currency ?? "EUR"),
  fee: parseMoney(o.fee ?? "0", o.currency ?? "EUR"),
  tax: parseMoney("0", o.currency ?? "EUR"),
  currency: o.currency ?? "EUR",
  fxRateEur: parseFxRate(o.rate ?? "1", o.currency ?? "EUR"),
});

test("a single buy becomes one open lot including its fee", () => {
  const { open, disposals } = buildLots([
    txn("BUY", "2025-01-10", { qty: "10", amount: "-1000,00", fee: "3,00" }),
  ]);
  expect(disposals).toHaveLength(0);
  expect(open).toHaveLength(1);
  expect(formatQuantity(open[0]!.quantity)).toBe("10.000000");
  expect(formatMoney(open[0]!.costEur)).toBe("1003.00");
});

test("a sale consumes the oldest lot first", () => {
  const { open, disposals } = buildLots([
    txn("BUY", "2025-01-10", { qty: "10", amount: "-1000,00" }), // 100.00/unit
    txn("BUY", "2025-02-10", { qty: "10", amount: "-1200,00" }), // 120.00/unit
    txn("SELL", "2025-03-10", { qty: "4", amount: "600,00" }), // 150.00/unit
  ]);
  expect(disposals).toHaveLength(1);
  expect(disposals[0]!.acquiredOn).toBe("2025-01-10");
  expect(formatMoney(disposals[0]!.costEur)).toBe("400.00");
  expect(formatMoney(disposals[0]!.proceedsEur)).toBe("600.00");
  expect(formatMoney(disposals[0]!.gainEur)).toBe("200.00");
  expect(open.map((l) => formatQuantity(l.quantity))).toEqual(["6.000000", "10.000000"]);
});

test("a sale spanning two lots produces two disposals", () => {
  const { open, disposals } = buildLots([
    txn("BUY", "2025-01-10", { qty: "10", amount: "-1000,00" }),
    txn("BUY", "2025-02-10", { qty: "10", amount: "-1200,00" }),
    txn("SELL", "2025-03-10", { qty: "15", amount: "2250,00" }), // 150.00/unit
  ]);
  expect(disposals).toHaveLength(2);
  expect(disposals.map((d) => formatMoney(d.costEur))).toEqual(["1000.00", "600.00"]);
  expect(disposals.map((d) => formatMoney(d.proceedsEur))).toEqual(["1500.00", "750.00"]);
  expect(open.map((l) => formatQuantity(l.quantity))).toEqual(["5.000000"]);
});

test("disposal fees reduce proceeds", () => {
  const { disposals } = buildLots([
    txn("BUY", "2025-01-10", { qty: "10", amount: "-1000,00" }),
    txn("SELL", "2025-03-10", { qty: "10", amount: "1200,00", fee: "5,00" }),
  ]);
  expect(formatMoney(disposals[0]!.proceedsEur)).toBe("1195.00");
  expect(formatMoney(disposals[0]!.gainEur)).toBe("195.00");
});

test("USD purchases are stored at the frozen EUR rate of their trade date", () => {
  const { open } = buildLots([
    txn("BUY", "2025-01-10", { qty: "10", amount: "-1000,00", currency: "USD", rate: "0,90" }),
  ]);
  expect(formatMoney(open[0]!.costEur)).toBe("900.00");
});

test("selling more units than held is a domain error", () => {
  expect(() =>
    buildLots([
      txn("BUY", "2025-01-10", { qty: "5", amount: "-500,00" }),
      txn("SELL", "2025-02-10", { qty: "6", amount: "700,00" }),
    ]),
  ).toThrow(/instrument 7.*2025-02-10/i);
});

test("a split rescales open lots without creating a disposal", () => {
  const { open, disposals } = buildLots([
    txn("BUY", "2025-01-10", { qty: "10", amount: "-1000,00" }),
    txn("SPLIT", "2025-05-10", { qty: "40" }),
  ]);
  expect(disposals).toHaveLength(0);
  expect(formatQuantity(open[0]!.quantity)).toBe("40.000000");
  expect(formatMoney(open[0]!.costEur)).toBe("1000.00");
});

test("cost basis at a date sums the open lots", () => {
  const txns = [
    txn("BUY", "2025-01-10", { qty: "10", amount: "-1000,00" }),
    txn("BUY", "2025-02-10", { qty: "10", amount: "-1200,00" }),
    txn("SELL", "2025-03-10", { qty: "4", amount: "600,00" }),
  ];
  expect(formatMoney(costBasisAt(txns, "2025-01-31").get(7)!)).toBe("1000.00");
  expect(formatMoney(costBasisAt(txns, "2025-12-31").get(7)!)).toBe("1800.00");
});

// --- Additional coverage beyond the brief's verbatim tests ---

test("a sale spanning three lots prorates proceeds without rounding drift", () => {
  // 1.00 EUR of proceeds split three ways is 0.333... per unit: a naive per-chunk
  // proportional rounding (half-up to 0.33 each) would total 0.99, not 1.00. The final
  // chunk must absorb the remainder so the disposals' proceeds always sum to the whole.
  const { disposals } = buildLots([
    txn("BUY", "2025-01-01", { qty: "1", amount: "-1,00" }),
    txn("BUY", "2025-01-02", { qty: "1", amount: "-1,00" }),
    txn("BUY", "2025-01-03", { qty: "1", amount: "-1,00" }),
    txn("SELL", "2025-02-01", { qty: "3", amount: "1,00" }),
  ]);
  expect(disposals.map((d) => formatMoney(d.proceedsEur))).toEqual(["0.33", "0.33", "0.34"]);
  const total = disposals.reduce((sum, d) => addMoney(sum, d.proceedsEur), zeroMoney("EUR"));
  expect(formatMoney(total)).toBe("1.00");
});

test("a split with an uneven ratio gives the remainder to the last lot", () => {
  // 1:2 rescaled to a total of 10 puts the boundary at 10/3, which has no exact
  // 6-decimal representation (3.333333...): the first lot's floor-rounded share and the
  // last lot's exact-remainder share must still add up to exactly 10.
  const { open } = buildLots([
    txn("BUY", "2025-01-10", { qty: "1", amount: "-100,00" }),
    txn("BUY", "2025-01-11", { qty: "2", amount: "-200,00" }),
    txn("SPLIT", "2025-05-10", { qty: "10" }),
  ]);
  expect(open.map((l) => formatQuantity(l.quantity))).toEqual(["3.333333", "6.666667"]);
  const total = open.reduce((sum, l) => sum + l.quantity.scaled, 0n);
  expect(total).toBe(10_000_000n);
  expect(open.map((l) => formatMoney(l.costEur))).toEqual(["100.00", "200.00"]);
});
