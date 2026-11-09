import { expect, test } from "vitest";

import { differences, reconcile, DEFAULT_TOLERANCE, type SnapshotPosition } from "./reconcile.ts";
import { EUR, formatQuantity, parseFxRate, parseMoney, parseQuantity } from "./money.ts";
import type { TransactionType, Txn } from "./types.ts";

let nextId = 1;
const txn = (
  type: TransactionType,
  tradeDate: string,
  o: { instrumentId?: number; qty?: string; amount?: string } = {},
): Txn => ({
  id: nextId++,
  accountId: 1,
  instrumentId: o.instrumentId ?? 7,
  type,
  tradeDate,
  quantity: parseQuantity(o.qty ?? "0"),
  unitPrice: null,
  amount: parseMoney(o.amount ?? "0", EUR),
  fee: parseMoney("0", EUR),
  tax: parseMoney("0", EUR),
  currency: EUR,
  fxRateEur: parseFxRate("1", EUR),
});

const stated = (instrumentId: number, qty: string): SnapshotPosition => ({
  instrumentId,
  quantity: parseQuantity(qty),
});

test("a statement that agrees with the ledger reports no differences", () => {
  const txns = [txn("BUY", "2026-01-05", { qty: "10", amount: "-1000,00" })];
  const rows = reconcile(txns, [stated(7, "10")], "2026-06-30");

  expect(rows).toHaveLength(1);
  expect(formatQuantity(rows[0]!.delta)).toBe("0.000000");
  expect(rows[0]!.withinTolerance).toBe(true);
  expect(rows[0]!.presence).toBe("both");
  expect(differences(rows)).toEqual([]);
});

// Brokers publish fund units to fewer decimals than the ledger stores.
test("a difference in the fifth decimal is rounding, not a missing transaction", () => {
  const txns = [txn("BUY", "2026-01-05", { qty: "12,595200", amount: "-1000,00" })];
  const rows = reconcile(txns, [stated(7, "12,5952")], "2026-06-30");
  expect(rows[0]!.withinTolerance).toBe(true);

  const coarser = reconcile(txns, [stated(7, "12,5953")], "2026-06-30");
  expect(coarser[0]!.withinTolerance).toBe(false);
  expect(formatQuantity(coarser[0]!.delta)).toBe("0.000100");
});

test("the delta says which way the ledger is wrong", () => {
  const txns = [txn("BUY", "2026-01-05", { qty: "10", amount: "-1000,00" })];
  // Statement holds more: an acquisition is missing.
  expect(formatQuantity(reconcile(txns, [stated(7, "15")], "2026-06-30")[0]!.delta)).toBe(
    "5.000000",
  );
  // Less: a disposal is missing.
  expect(formatQuantity(reconcile(txns, [stated(7, "4")], "2026-06-30")[0]!.delta)).toBe(
    "-6.000000",
  );
});

test("an instrument only one side knows about is reported as such, not as a quantity difference", () => {
  const txns = [txn("BUY", "2026-01-05", { instrumentId: 7, qty: "10", amount: "-1000,00" })];
  const rows = reconcile(txns, [stated(8, "3")], "2026-06-30");

  const ledgerOnly = rows.find((r) => r.instrumentId === 7)!;
  expect(ledgerOnly.presence).toBe("ledger-only");
  expect(formatQuantity(ledgerOnly.delta)).toBe("-10.000000");

  const snapshotOnly = rows.find((r) => r.instrumentId === 8)!;
  expect(snapshotOnly.presence).toBe("snapshot-only");
  expect(formatQuantity(snapshotOnly.delta)).toBe("3.000000");
});

test("positions are derived as of the statement's date, not today", () => {
  const txns = [
    txn("BUY", "2026-01-05", { qty: "10", amount: "-1000,00" }),
    txn("BUY", "2026-09-01", { qty: "5", amount: "-500,00" }),
  ];
  expect(reconcile(txns, [stated(7, "10")], "2026-06-30")[0]!.withinTolerance).toBe(true);
  expect(reconcile(txns, [stated(7, "10")], "2026-09-30")[0]!.withinTolerance).toBe(false);
});

test("a split is honoured, since the ledger derives positions through it", () => {
  const txns = [
    txn("BUY", "2026-01-05", { qty: "1000", amount: "-1000,00" }),
    txn("SPLIT", "2026-03-01", { qty: "10" }),
  ];
  expect(reconcile(txns, [stated(7, "10")], "2026-06-30")[0]!.withinTolerance).toBe(true);
});

test("rows come back in a stable order", () => {
  const txns = [txn("BUY", "2026-01-05", { instrumentId: 9, qty: "1", amount: "-10,00" })];
  const rows = reconcile(txns, [stated(3, "1"), stated(11, "1")], "2026-06-30");
  expect(rows.map((r) => r.instrumentId)).toEqual([3, 9, 11]);
});

test("the tolerance is configurable, for a broker that rounds harder", () => {
  const txns = [txn("BUY", "2026-01-05", { qty: "10", amount: "-1000,00" })];
  const rows = reconcile(txns, [stated(7, "10,01")], "2026-06-30", {
    tolerance: parseQuantity("0,02"),
  });
  expect(rows[0]!.withinTolerance).toBe(true);
  expect(formatQuantity(DEFAULT_TOLERANCE)).toBe("0.000050");
});
