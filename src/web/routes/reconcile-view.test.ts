import { expect, test } from "vitest";

import { explain, needsAttention, type ReconcileRow } from "./reconcile-view.ts";

const row = (over: Partial<ReconcileRow> = {}): ReconcileRow => ({
  instrumentId: 1,
  name: "Test Fund",
  derived: "10.000000",
  snapshot: "10.000000",
  delta: "0.000000",
  withinTolerance: true,
  presence: "both",
  ...over,
});

test("a matching row says so", () => {
  expect(explain(row())).toBe("Täsmää");
});

test("a holding only the statement knows is called a missing import, not a miscount", () => {
  const message = explain(row({ presence: "snapshot-only", withinTolerance: false, delta: "3" }));
  expect(message).toContain("Vain otteella");
});

test("a holding only the ledger knows points at a missing sale", () => {
  const message = explain(row({ presence: "ledger-only", withinTolerance: false, delta: "-3" }));
  expect(message).toContain("Vain kirjanpidossa");
});

test("a plain quantity difference says which way it runs", () => {
  expect(explain(row({ withinTolerance: false, delta: "5.000000" }))).toContain("puuttuu osuuksia");
  expect(explain(row({ withinTolerance: false, delta: "-5.000000" }))).toContain("liikaa osuuksia");
});

test("attention list drops rounding and puts the largest difference first", () => {
  const rows = [
    row({ instrumentId: 1 }),
    row({ instrumentId: 2, withinTolerance: false, delta: "1.500000" }),
    row({ instrumentId: 3, withinTolerance: false, delta: "-9.000000" }),
  ];
  expect(needsAttention(rows).map((r) => r.instrumentId)).toEqual([3, 2]);
});
