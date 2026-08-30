import { test, expect } from "vitest";
import { sortHoldings, type Holding } from "./holdings-sort.ts";

const row = (name: string, valueEur: string, unrealisedEur: string): Holding => ({
  instrumentId: 1,
  isin: "FI0000000000",
  name,
  kind: "stock",
  currency: "EUR",
  quantity: "1.000000",
  costEur: "100.00",
  valueEur,
  unrealisedEur,
  weight: Number(valueEur) / 1000,
  priceDate: "2025-06-02",
  stale: false,
  costBasisError: null,
  valuationError: null,
});

test("sorts by value descending by default", () => {
  const rows = [row("A", "100.00", "0.00"), row("B", "500.00", "0.00"), row("C", "250.00", "0.00")];
  expect(sortHoldings(rows, "valueEur", "desc").map((r) => r.name)).toEqual(["B", "C", "A"]);
});

test("sorts numerically, not lexically", () => {
  const rows = [row("A", "9.00", "0.00"), row("B", "100.00", "0.00")];
  expect(sortHoldings(rows, "valueEur", "desc").map((r) => r.name)).toEqual(["B", "A"]);
});

test("handles negative unrealised gains", () => {
  const rows = [row("A", "1.00", "-50.00"), row("B", "1.00", "10.00")];
  expect(sortHoldings(rows, "unrealisedEur", "asc").map((r) => r.name)).toEqual(["A", "B"]);
});

test("sorts names with Finnish collation", () => {
  const rows = [row("Ähtäri Oyj", "1.00", "0.00"), row("Aalto Oyj", "1.00", "0.00")];
  expect(sortHoldings(rows, "name", "asc").map((r) => r.name)).toEqual(["Aalto Oyj", "Ähtäri Oyj"]);
});

test("sorting is stable and does not mutate the input array", () => {
  const rows = [row("A", "100.00", "0.00"), row("B", "500.00", "0.00")];
  const sorted = sortHoldings(rows, "valueEur", "desc");
  expect(sorted).not.toBe(rows);
  expect(rows.map((r) => r.name)).toEqual(["A", "B"]);
});

test("a holding with an unknown cost basis (null costEur/valueEur/unrealisedEur) sorts as zero, not NaN", () => {
  const rows: Holding[] = [
    {
      ...row("A", "0.00", "0.00"),
      costEur: null,
      valueEur: null,
      unrealisedEur: null,
      costBasisError: { tradeDate: "2025-01-01", message: "ei voi käsitellä" },
    },
    row("B", "50.00", "0.00"),
  ];
  expect(sortHoldings(rows, "valueEur", "desc").map((r) => r.name)).toEqual(["B", "A"]);
});

test("a never-priced holding (priceDate null) sorts as zero value, not NaN", () => {
  const rows = [
    { ...row("A", "0.00", "0.00"), priceDate: null, stale: true },
    row("B", "50.00", "0.00"),
  ];
  expect(sortHoldings(rows, "valueEur", "desc").map((r) => r.name)).toEqual(["B", "A"]);
});

test("sorts by weight, a number rather than a decimal string, like the money columns", () => {
  const rows = [
    { ...row("A", "100.00", "0.00"), weight: 0.1 },
    { ...row("B", "100.00", "0.00"), weight: 0.6 },
    { ...row("C", "100.00", "0.00"), weight: 0.3 },
  ];
  expect(sortHoldings(rows, "weight", "desc").map((r) => r.name)).toEqual(["B", "C", "A"]);
  expect(sortHoldings(rows, "weight", "asc").map((r) => r.name)).toEqual(["A", "C", "B"]);
});

test("a holding that cannot be valued (weight null) sorts as zero, not NaN, and does not mutate the input", () => {
  const rows: Holding[] = [
    { ...row("A", "0.00", "0.00"), weight: null, valueEur: null, valuationError: "ei hintaa" },
    { ...row("B", "50.00", "0.00"), weight: 0.5 },
  ];
  expect(sortHoldings(rows, "weight", "desc").map((r) => r.name)).toEqual(["B", "A"]);
  expect(rows[0]!.weight).toBeNull();
});
