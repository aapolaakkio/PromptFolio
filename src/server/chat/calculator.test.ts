import { describe, expect, test } from "bun:test";

import { calculate } from "./calculator";

// The assistant may now do arithmetic, which it could not before. This is what
// keeps that safe: the sums happen in integer hundredths, so a figure it states
// is exact rather than whatever a float came to.

describe("calculate", () => {
  test("adds money exactly, where floating point would not", () => {
    // 0.1 + 0.2 is 0.30000000000000004 in a float, and a euro figure ending in
    // four is the kind of wrong that survives review.
    expect(calculate({ operation: "sum", values: ["0.10", "0.20"] }).result).toBe("0.30");
    expect(calculate({ operation: "sum", values: ["42.15", "31.20", "18.50"] }).result).toBe(
      "91.85",
    );
  });

  test("subtracts in the order given", () => {
    expect(calculate({ operation: "subtract", values: ["1000.00", "42.15", "7.85"] }).result).toBe(
      "950.00",
    );
  });

  test("multiplies money by a plain number", () => {
    expect(calculate({ operation: "multiply", values: ["12.50", "4"] }).result).toBe("50.00");
  });

  test("divides, rounding half up at the cent", () => {
    expect(calculate({ operation: "divide", values: ["10.00", "3"] }).result).toBe("3.33");
    expect(calculate({ operation: "divide", values: ["1.00", "8"] }).result).toBe("0.13");
  });

  test("takes a percentage of a sum", () => {
    expect(calculate({ operation: "percent", values: ["2000.00", "7.5"] }).result).toBe("150.00");
  });

  test("averages", () => {
    expect(calculate({ operation: "average", values: ["10.00", "20.00", "31.00"] }).result).toBe(
      "20.33",
    );
  });

  test("keeps a negative amount negative, which spending always is", () => {
    expect(calculate({ operation: "sum", values: ["-42.15", "-31.20"] }).result).toBe("-73.35");
  });

  test("accepts the Finnish decimal comma, since that is how figures are read here", () => {
    expect(calculate({ operation: "sum", values: ["42,15", "31,20"] }).result).toBe("73.35");
  });

  test("shows its working, so an answer can say where a figure came from", () => {
    expect(calculate({ operation: "sum", values: ["10.00", "5.00"] }).working).toBe(
      "10.00 + 5.00 = 15.00",
    );
    expect(calculate({ operation: "percent", values: ["200.00", "10"] }).working).toBe(
      "10 % luvusta 200.00 = 20.00",
    );
  });

  test("refuses something that is not a number rather than treating it as zero", () => {
    expect(() => calculate({ operation: "sum", values: ["noin sata"] })).toThrow(/ei kelpaa/);
  });

  test("refuses division by zero instead of returning an infinity", () => {
    expect(() => calculate({ operation: "divide", values: ["10.00", "0"] })).toThrow(/Nollalla/);
  });

  test("refuses an empty calculation", () => {
    expect(() => calculate({ operation: "sum", values: [] })).toThrow(/vähintään yksi/);
  });

  test("rounds a third of a cent rather than dropping it", () => {
    // 0.005 is a half cent: kept as 0.01 so a division and its inverse agree.
    expect(calculate({ operation: "sum", values: ["0.005", "0"] }).result).toBe("0.01");
  });
});
