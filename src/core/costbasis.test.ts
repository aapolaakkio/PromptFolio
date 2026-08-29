import { test, expect } from "bun:test";
import {
  buildLots,
  costBasisAt,
  costBasisPerInstrument,
  UnmatchedDisposalError,
} from "./costbasis";
import type { Txn, TransactionType } from "./types";
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
} from "./money";

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

// `amount` is the fee-inclusive total cash that moved (see `Txn.amount`'s doc
// in core/types.ts) -- it is what both real brokers report (OP's `Yhteensä`,
// Nordnet's `Summa`), and `core/ledger.ts`'s `cashAt` relies on it being the
// true cash movement. `fee` is carried alongside purely for reporting and must
// never be added to (or subtracted from) `amount` again here -- doing so was
// exactly C2: a real broker fee got double-counted into cost basis/proceeds.
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
  // Instrument 7 (this file's `txn()` default) has a perfectly ordinary buy.
  // Instrument 8 has a SELL with no matching prior BUY at all -- e.g. one page
  // of a multi-page OP import pasted out of order.
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

// A share swap moves a holding between two instruments with no cash: the
// arriving leg's amount is zero, so without carrying the basis across, the new
// holding would be priced at nothing and report its whole value as gain.
test("a share swap carries the departing leg's cost basis to the arriving one", () => {
  const bought = {
    ...txn("BUY", "2019-11-03", { qty: "900", amount: "-27.00" }),
    instrumentId: 1,
  };
  // OP prints the arriving leg above the departing one, so the ledger sees it
  // first by id -- the ordering inside buildLots is what fixes that.
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
  // The line the shares left keeps nothing.
  expect(open.filter((lot) => lot.instrumentId === 1)).toEqual([]);
});

test("a transfer in that states its own cost keeps it, rather than claiming a carried one", () => {
  const bought = { ...txn("BUY", "2023-01-01", { qty: "10", amount: "-10.00" }), instrumentId: 1 };
  const departed = {
    ...txn("TRANSFER_OUT", "2023-06-01", { qty: "10", amount: "0" }),
    instrumentId: 1,
  };
  // Nordnet states Hankinta-arvo on the arriving row; that figure wins.
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

// vero.fi states the matching rule as "The FIFO principle must always be
// applied to the sale of shares from securities accounts: First In - First
// Out" *within one account*. Lots were previously pooled by instrument alone,
// which is a different rule that happens to agree whenever an instrument is
// held in only one account.
test("FIFO is per account: disposing from one account does not consume another account's lots", () => {
  const { disposals } = buildLots([
    txn("BUY", "2025-01-10", { qty: "10", amount: "-100,00", accountId: 1 }),
    txn("BUY", "2025-02-10", { qty: "10", amount: "-500,00", accountId: 2 }),
    txn("SELL", "2025-06-01", { qty: "10", amount: "600,00", accountId: 2 }),
  ]);

  expect(disposals).toHaveLength(1);
  // Pooling would take account 1's cheaper lot first and report a 500,00 gain
  // against an account that never held it.
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
      .sort(),
  ).toEqual([1, 2]);
  // A position spans accounts even though tax does not, so the holdings view's
  // per-instrument total must not change with this split.
  expect(formatMoney(costBasisAt(txns, "2025-12-31").get(7) ?? zeroMoney(EUR))).toBe("600.00");
});

test("a disposal carries its share of the sale fee, which the deemed-cost base needs", () => {
  const { disposals } = buildLots([
    txn("BUY", "2025-01-10", { qty: "10", amount: "-100,00" }),
    txn("SELL", "2025-06-01", { qty: "10", amount: "590,00", fee: "10,00" }),
  ]);

  // `amount` is already net of the fee, so the gross sale price -- the base the
  // hankintameno-olettama is a percentage of -- is `amount + fee`.
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
  // 10,01 does not halve evenly: the last lot absorbs the remainder rather
  // than the split quietly losing a cent.
  expect(formatMoney(total)).toBe("10.01");
});
