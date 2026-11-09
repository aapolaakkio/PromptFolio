import { test, expect } from "vitest";
import {
  buildLots,
  costBasisAt,
  costBasisPerInstrument,
  UnmatchedDisposalError,
} from "./costbasis.ts";
import type { Txn, TransactionType } from "./types.ts";
import {
  parseMoney,
  parseQuantity,
  parseFxRate,
  parseCurrency,
  formatMoney,
  formatQuantity,
  addMoney,
  zeroMoney,
  EUR,
  type Currency,
} from "./money.ts";

const USD = parseCurrency("USD");

let nextId = 1;
const txn = (
  type: TransactionType,
  tradeDate: string,
  o: {
    qty?: string;
    amount?: string;
    fee?: string;
    currency?: Currency;
    rate?: string;
    accountId?: number;
    instrumentId?: number;
  } = {},
): Txn => ({
  id: nextId++,
  accountId: o.accountId ?? 1,
  instrumentId: o.instrumentId ?? 7,
  type,
  tradeDate,
  quantity: parseQuantity(o.qty ?? "0"),
  unitPrice: null,
  amount: parseMoney(o.amount ?? "0", o.currency ?? EUR),
  fee: parseMoney(o.fee ?? "0", o.currency ?? EUR),
  tax: parseMoney("0", o.currency ?? EUR),
  currency: o.currency ?? EUR,
  fxRateEur: parseFxRate(o.rate ?? "1", o.currency ?? EUR),
});

// `amount` is fee-inclusive cash (the broker's total column); `fee` is reporting only and must not be applied again.
test("a single buy's cost basis is its fee-inclusive amount, unadjusted by fee", () => {
  const { open, disposals } = buildLots([
    txn("BUY", "2025-01-10", { qty: "10", amount: "-1003,00", fee: "3,00" }),
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

test("disposal proceeds are its fee-inclusive amount, unadjusted by fee", () => {
  const { disposals } = buildLots([
    txn("BUY", "2025-01-10", { qty: "10", amount: "-1000,00" }),
    txn("SELL", "2025-03-10", { qty: "10", amount: "1195,00", fee: "5,00" }),
  ]);
  expect(formatMoney(disposals[0]!.proceedsEur)).toBe("1195.00");
  expect(formatMoney(disposals[0]!.gainEur)).toBe("195.00");
});

test("USD purchases are stored at the frozen EUR rate of their trade date", () => {
  const { open } = buildLots([
    txn("BUY", "2025-01-10", { qty: "10", amount: "-1000,00", currency: USD, rate: "0,90" }),
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

test("costBasisPerInstrument isolates one instrument's UnmatchedDisposalError from another instrument's own cost basis", () => {
  // Instrument 7 has an ordinary buy; 8 has a SELL with no prior BUY (pages imported out of order).
  const ok = txn("BUY", "2025-01-10", { qty: "10", amount: "-1000,00" });
  const broken = { ...txn("SELL", "2025-01-05", { qty: "5", amount: "500,00" }), instrumentId: 8 };

  const outcomes = costBasisPerInstrument([ok, broken], "2025-12-31");

  const okOutcome = outcomes.get(7);
  expect(okOutcome?.ok).toBe(true);
  if (!okOutcome?.ok) throw new Error("expected instrument 7 to resolve");
  expect(formatMoney(okOutcome.costEur)).toBe("1000.00");

  const brokenOutcome = outcomes.get(8);
  expect(brokenOutcome?.ok).toBe(false);
  if (!brokenOutcome || brokenOutcome.ok) throw new Error("expected instrument 8 to fail");
  expect(brokenOutcome.error).toBeInstanceOf(UnmatchedDisposalError);
  expect(brokenOutcome.error.instrumentId).toBe(8);
  expect(brokenOutcome.error.tradeDate).toBe("2025-01-05");
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

test("a sale spanning three lots prorates proceeds without rounding drift", () => {
  // Per-chunk half-up would total 0.99 for 1.00 split three ways; the final chunk must absorb the remainder.
  const { disposals } = buildLots([
    txn("BUY", "2025-01-01", { qty: "1", amount: "-1,00" }),
    txn("BUY", "2025-01-02", { qty: "1", amount: "-1,00" }),
    txn("BUY", "2025-01-03", { qty: "1", amount: "-1,00" }),
    txn("SELL", "2025-02-01", { qty: "3", amount: "1,00" }),
  ]);
  expect(disposals.map((d) => formatMoney(d.proceedsEur))).toEqual(["0.33", "0.33", "0.34"]);
  const total = disposals.reduce((sum, d) => addMoney(sum, d.proceedsEur), zeroMoney(EUR));
  expect(formatMoney(total)).toBe("1.00");
});

test("a TRANSFER_IN creates an open lot with the stated cost, its fee-inclusive amount unadjusted by fee", () => {
  const { open, disposals } = buildLots([
    txn("TRANSFER_IN", "2025-01-10", { qty: "10", amount: "-1003,00", fee: "3,00" }),
  ]);
  expect(disposals).toHaveLength(0);
  expect(open).toHaveLength(1);
  expect(formatQuantity(open[0]!.quantity)).toBe("10.000000");
  expect(formatMoney(open[0]!.costEur)).toBe("1003.00");
});

test("a TRANSFER_OUT consumes lots FIFO and produces a disposal, like a sale", () => {
  const { open, disposals } = buildLots([
    txn("BUY", "2025-01-10", { qty: "10", amount: "-1000,00" }), // 100.00/unit
    txn("BUY", "2025-02-10", { qty: "10", amount: "-1200,00" }), // 120.00/unit
    txn("TRANSFER_OUT", "2025-03-10", { qty: "15", amount: "2250,00" }), // 150.00/unit
  ]);
  expect(disposals).toHaveLength(2);
  expect(disposals.map((d) => formatMoney(d.costEur))).toEqual(["1000.00", "600.00"]);
  expect(disposals.map((d) => formatMoney(d.proceedsEur))).toEqual(["1500.00", "750.00"]);
  expect(open.map((l) => formatQuantity(l.quantity))).toEqual(["5.000000"]);
});

test("a BUY (or TRANSFER_IN) with a non-negative amount is a domain error", () => {
  expect(() => buildLots([txn("BUY", "2025-01-10", { qty: "10", amount: "1000,00" })])).toThrow(
    /instrument 7.*2025-01-10/i,
  );
  expect(() =>
    buildLots([txn("TRANSFER_IN", "2025-01-10", { qty: "10", amount: "1000,00" })]),
  ).toThrow(/instrument 7.*2025-01-10/i);
});

test("a split with an uneven ratio gives the remainder to the last lot", () => {
  // 10/3 has no exact 6-decimal form: the floor-rounded share and the exact-remainder share must still sum to 10.
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

// A share swap moves no cash: the basis must carry across or the new holding reports its whole value as gain.
test("a share swap carries the departing leg's cost basis to the arriving one", () => {
  const bought = {
    ...txn("BUY", "2019-11-03", { qty: "900", amount: "-27.00" }),
    instrumentId: 1,
  };
  // OP prints the arriving leg first; buildLots ordering fixes that.
  const arrived = {
    ...txn("TRANSFER_IN", "2019-11-24", { qty: "900", amount: "0" }),
    instrumentId: 2,
  };
  const departed = {
    ...txn("TRANSFER_OUT", "2019-11-24", { qty: "900", amount: "0" }),
    instrumentId: 1,
  };

  const { open } = buildLots([bought, arrived, departed]);
  const received = open.filter((lot) => lot.instrumentId === 2);
  expect(received).toHaveLength(1);
  expect(formatMoney(received[0]!.costEur)).toBe("27.00");
  expect(open.filter((lot) => lot.instrumentId === 1)).toEqual([]);
});

test("a transfer in that states its own cost keeps it, rather than claiming a carried one", () => {
  const bought = { ...txn("BUY", "2023-01-01", { qty: "10", amount: "-10.00" }), instrumentId: 1 };
  const departed = {
    ...txn("TRANSFER_OUT", "2023-06-01", { qty: "10", amount: "0" }),
    instrumentId: 1,
  };
  // Nordnet states the acquisition cost on the arriving row; that figure wins.
  const arrived = {
    ...txn("TRANSFER_IN", "2023-06-01", { qty: "4", amount: "-32.72" }),
    instrumentId: 2,
  };

  const { open } = buildLots([bought, departed, arrived]);
  expect(formatMoney(open.find((lot) => lot.instrumentId === 2)!.costEur)).toBe("32.72");
});

test("a transfer in on a date with no matching transfer out gets no invented cost", () => {
  const arrived = {
    ...txn("TRANSFER_IN", "2023-06-01", { qty: "5", amount: "0" }),
    instrumentId: 2,
  };
  expect(formatMoney(buildLots([arrived]).open[0]!.costEur)).toBe("0.00");
});

// vero.fi: FIFO applies within one account, so lots must not pool by instrument alone.
test("FIFO is per account: disposing from one account does not consume another account's lots", () => {
  const { disposals } = buildLots([
    txn("BUY", "2025-01-10", { qty: "10", amount: "-100,00", accountId: 1 }),
    txn("BUY", "2025-02-10", { qty: "10", amount: "-500,00", accountId: 2 }),
    txn("SELL", "2025-06-01", { qty: "10", amount: "600,00", accountId: 2 }),
  ]);

  expect(disposals).toHaveLength(1);
  // Pooling would take account 1's cheaper lot and report a 500,00 gain against an account that never held it.
  expect(formatMoney(disposals[0]!.costEur)).toBe("500.00");
  expect(formatMoney(disposals[0]!.gainEur)).toBe("100.00");
  expect(disposals[0]!.accountId).toBe(2);
});

test("each account keeps its own open lots, while the instrument's total still spans both", () => {
  const txns = [
    txn("BUY", "2025-01-10", { qty: "10", amount: "-100,00", accountId: 1 }),
    txn("BUY", "2025-02-10", { qty: "10", amount: "-500,00", accountId: 2 }),
  ];

  expect(
    buildLots(txns)
      .open.map((lot) => lot.accountId)
      .sort((a, b) => a - b),
  ).toEqual([1, 2]);
  // Per-instrument totals must not change with the account split.
  expect(formatMoney(costBasisAt(txns, "2025-12-31").get(7) ?? zeroMoney(EUR))).toBe("600.00");
});

test("a disposal carries its share of the sale fee, which the deemed-cost base needs", () => {
  const { disposals } = buildLots([
    txn("BUY", "2025-01-10", { qty: "10", amount: "-100,00" }),
    txn("SELL", "2025-06-01", { qty: "10", amount: "590,00", fee: "10,00" }),
  ]);

  // The deemed acquisition cost is a percentage of the gross price, `amount + fee`.
  expect(formatMoney(disposals[0]!.proceedsEur)).toBe("590.00");
  expect(formatMoney(disposals[0]!.feeEur)).toBe("10.00");
});

test("a fee is split across the lots a sale consumes, and the parts sum to the whole", () => {
  const { disposals } = buildLots([
    txn("BUY", "2025-01-10", { qty: "5", amount: "-50,00" }),
    txn("BUY", "2025-02-10", { qty: "5", amount: "-50,00" }),
    txn("SELL", "2025-06-01", { qty: "10", amount: "990,00", fee: "10,01" }),
  ]);

  expect(disposals).toHaveLength(2);
  const total = disposals.reduce((sum, d) => addMoney(sum, d.feeEur), zeroMoney(EUR));
  // 10,01 does not halve evenly: the last lot absorbs the remainder.
  expect(formatMoney(total)).toBe("10.01");
});

// A swap keeps each lot's acquisition date (sets the deemed-cost percentage) and cost (consumed by later partial sales).
test("a share swap carries the departing lots, keeping their acquisition dates", () => {
  const { open } = buildLots([
    txn("BUY", "2020-12-07", { qty: "6", amount: "-60,00", instrumentId: 1 }),
    txn("BUY", "2021-05-05", { qty: "6", amount: "-120,00", instrumentId: 1 }),
    txn("TRANSFER_OUT", "2023-10-04", { qty: "12", amount: "0", instrumentId: 1 }),
    txn("TRANSFER_IN", "2023-10-04", { qty: "6", amount: "0", instrumentId: 2 }),
  ]);

  expect(open).toHaveLength(2);
  expect(open.map((lot) => lot.acquiredOn)).toEqual(["2020-12-07", "2021-05-05"]);
  expect(open.map((lot) => formatQuantity(lot.quantity))).toEqual(["3.000000", "3.000000"]);
  expect(open.map((lot) => formatMoney(lot.costEur))).toEqual(["60.00", "120.00"]);
});

test("a sale after a swap consumes the oldest carried lot first, not the position pro rata", () => {
  const { disposals } = buildLots([
    txn("BUY", "2020-12-07", { qty: "6", amount: "-60,00", instrumentId: 1 }),
    txn("BUY", "2021-05-05", { qty: "6", amount: "-120,00", instrumentId: 1 }),
    txn("TRANSFER_OUT", "2023-10-04", { qty: "12", amount: "0", instrumentId: 1 }),
    txn("TRANSFER_IN", "2023-10-04", { qty: "6", amount: "0", instrumentId: 2 }),
    txn("SELL", "2023-10-10", { qty: "3", amount: "50,00", instrumentId: 2 }),
  ]);

  // The swap's own legs are disposals too; read only the sale's row.
  const sold = disposals.filter((disposal) => disposal.soldOn === "2023-10-10");

  // FIFO takes the whole 2020 lot at 60,00; pro rata over a merged position would take 90,00.
  expect(sold).toHaveLength(1);
  expect(formatMoney(sold[0]!.costEur)).toBe("60.00");
  expect(sold[0]!.acquiredOn).toBe("2020-12-07");
});

test("an arriving leg that states a value the departing leg did not give up is taken at its word", () => {
  // A different stated total is not a plain swap, and is taken at its word.
  const { open } = buildLots([
    txn("BUY", "2020-12-07", { qty: "6", amount: "-60,00", instrumentId: 1 }),
    txn("TRANSFER_OUT", "2023-10-04", { qty: "6", amount: "0", instrumentId: 1 }),
    txn("TRANSFER_IN", "2023-10-04", { qty: "6", amount: "-90,00", instrumentId: 2 }),
  ]);

  expect(open).toHaveLength(1);
  expect(formatMoney(open[0]!.costEur)).toBe("90.00");
  expect(open[0]!.acquiredOn).toBe("2023-10-04");
});
