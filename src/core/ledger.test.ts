import { test, expect } from "bun:test";
import {
  accountsMissingCashRecord,
  cashAt,
  externalCashFlows,
  fundingCashFlows,
  negativePositionIds,
  positionsAt,
} from "./ledger";
import type { Txn, TransactionType } from "./types";
import {
  parseMoney,
  parseQuantity,
  parseFxRate,
  parseCurrency,
  formatMoney,
  formatQuantity,
  EUR,
  type Currency,
} from "./money";

const USD = parseCurrency("USD");

let nextId = 1;
const txn = (
  type: TransactionType,
  tradeDate: string,
  opts: {
    instrumentId?: number;
    qty?: string;
    amount?: string;
    currency?: Currency;
    rate?: string;
  } = {},
): Txn => ({
  id: nextId++,
  accountId: 1,
  instrumentId: opts.instrumentId ?? null,
  type,
  tradeDate,
  quantity: parseQuantity(opts.qty ?? "0"),
  unitPrice: null,
  amount: parseMoney(opts.amount ?? "0", opts.currency ?? EUR),
  fee: parseMoney("0", opts.currency ?? EUR),
  tax: parseMoney("0", opts.currency ?? EUR),
  currency: opts.currency ?? EUR,
  fxRateEur: parseFxRate(opts.rate ?? "1", opts.currency ?? EUR),
});

test("accumulates buys and sells into positions", () => {
  const txns = [
    txn("BUY", "2025-01-10", { instrumentId: 7, qty: "10", amount: "-1000,00" }),
    txn("BUY", "2025-02-10", { instrumentId: 7, qty: "5", amount: "-520,00" }),
    txn("SELL", "2025-03-10", { instrumentId: 7, qty: "3", amount: "330,00" }),
  ];
  const pos = positionsAt(txns, "2025-12-31");
  expect(formatQuantity(pos.get(7)!)).toBe("12.000000");
});

test("negativePositionIds reports an instrument sold with no matching prior buy", () => {
  const txns = [txn("SELL", "2025-01-10", { instrumentId: 7, qty: "10", amount: "1000,00" })];
  expect(negativePositionIds(txns, "2025-01-10")).toEqual([7]);
});

test("negativePositionIds is empty for an ordinary, fully-covered position", () => {
  const txns = [
    txn("BUY", "2025-01-10", { instrumentId: 7, qty: "10", amount: "-1000,00" }),
    txn("SELL", "2025-02-10", { instrumentId: 7, qty: "3", amount: "330,00" }),
  ];
  expect(negativePositionIds(txns, "2025-12-31")).toEqual([]);
});

test("ignores transactions after the as-of date", () => {
  const txns = [
    txn("BUY", "2025-01-10", { instrumentId: 7, qty: "10", amount: "-1000,00" }),
    txn("BUY", "2025-06-10", { instrumentId: 7, qty: "5", amount: "-520,00" }),
  ];
  expect(formatQuantity(positionsAt(txns, "2025-03-01").get(7)!)).toBe("10.000000");
});

test("omits instruments whose position has closed", () => {
  const txns = [
    txn("BUY", "2025-01-10", { instrumentId: 7, qty: "10", amount: "-1000,00" }),
    txn("SELL", "2025-02-10", { instrumentId: 7, qty: "10", amount: "1100,00" }),
  ];
  expect(positionsAt(txns, "2025-12-31").has(7)).toBe(false);
});

test("transfers in and out move units without cash", () => {
  const txns = [
    txn("TRANSFER_IN", "2020-01-02", { instrumentId: 9, qty: "100" }),
    txn("TRANSFER_OUT", "2021-01-02", { instrumentId: 9, qty: "40" }),
  ];
  expect(formatQuantity(positionsAt(txns, "2025-01-01").get(9)!)).toBe("60.000000");
  expect(formatMoney(cashAt(txns, "2025-01-01", EUR))).toBe("0.00");
});

test("a split multiplies units and leaves cash alone", () => {
  const txns = [
    txn("BUY", "2025-01-10", { instrumentId: 7, qty: "10", amount: "-1000,00" }),
    // SPLIT quantity carries the resulting total units, not a delta
    txn("SPLIT", "2025-05-10", { instrumentId: 7, qty: "40" }),
  ];
  expect(formatQuantity(positionsAt(txns, "2025-12-31").get(7)!)).toBe("40.000000");
});

test("sums cash per currency", () => {
  const txns = [
    txn("DEPOSIT", "2025-01-01", { amount: "5000,00" }),
    txn("BUY", "2025-01-10", { instrumentId: 7, qty: "10", amount: "-1000,00" }),
    txn("DIVIDEND", "2025-04-10", { instrumentId: 7, amount: "35,50" }),
    txn("FEE", "2025-04-10", { amount: "-2,90" }),
    txn("BUY", "2025-05-10", {
      instrumentId: 8,
      qty: "2",
      amount: "-300,00",
      currency: USD,
      rate: "0,92",
    }),
  ];
  expect(formatMoney(cashAt(txns, "2025-12-31", EUR))).toBe("4032.60");
  expect(formatMoney(cashAt(txns, "2025-12-31", USD))).toBe("-300.00");
});

test("external cash flows are deposits and withdrawals only, in EUR", () => {
  const txns = [
    txn("DEPOSIT", "2025-01-01", { amount: "5000,00" }),
    txn("BUY", "2025-01-10", { instrumentId: 7, qty: "10", amount: "-1000,00" }),
    txn("WITHDRAWAL", "2025-09-01", { amount: "-500,00" }),
    txn("DEPOSIT", "2025-10-01", { amount: "1000,00", currency: USD, rate: "0,92" }),
  ];
  const flows = externalCashFlows(txns);
  expect(flows.map((f) => f.date)).toEqual(["2025-01-01", "2025-09-01", "2025-10-01"]);
  expect(flows.map((f) => formatMoney(f.amountEur))).toEqual(["5000.00", "-500.00", "920.00"]);
});

// OP's web transaction view exports securities transactions only: no deposits,
// ever. Measured against Nordnet's deposits alone, a real portfolio reported a
// money-weighted return roughly three times the truth, because the money that
// funded OP's purchases never entered the ledger at all.
const inAccount = (accountId: number, t: Txn): Txn => ({ ...t, accountId });

test("an account with no cash record has its contributions read from purchases", () => {
  const txns: Txn[] = [
    inAccount(1, txn("DEPOSIT", "2020-01-01", { amount: "1000.00" })),
    inAccount(1, txn("BUY", "2020-01-02", { instrumentId: 7, amount: "-900.00" })),
    inAccount(2, txn("BUY", "2020-02-01", { instrumentId: 8, amount: "-500.00" })),
  ];

  expect(accountsMissingCashRecord(txns)).toEqual([2]);
  // Account 1 keeps cash, so its deposit counts and its purchase does not --
  // counting both would double the same money.
  expect(fundingCashFlows(txns).map((f) => formatMoney(f.amountEur))).toEqual([
    "1000.00",
    "500.00",
  ]);
});

test("an account that records cash contributes only its deposits and withdrawals", () => {
  const txns: Txn[] = [
    inAccount(1, txn("DEPOSIT", "2020-01-01", { amount: "1000.00" })),
    inAccount(1, txn("BUY", "2020-01-02", { instrumentId: 7, amount: "-900.00" })),
    inAccount(1, txn("WITHDRAWAL", "2020-03-01", { amount: "-200.00" })),
  ];
  expect(accountsMissingCashRecord(txns)).toEqual([]);
  expect(fundingCashFlows(txns).map((f) => formatMoney(f.amountEur))).toEqual([
    "1000.00",
    "-200.00",
  ]);
});

test("a sale in a cash-less account is a withdrawal of invested money", () => {
  const txns: Txn[] = [
    inAccount(2, txn("BUY", "2020-02-01", { instrumentId: 8, amount: "-500.00" })),
    inAccount(2, txn("SELL", "2021-02-01", { instrumentId: 8, amount: "700.00" })),
  ];
  expect(fundingCashFlows(txns).map((f) => formatMoney(f.amountEur))).toEqual([
    "500.00",
    "-700.00",
  ]);
});
