import { test, expect } from "bun:test";
import { eur, qty, pct, fiDate } from "./format";

// fi-FI uses a comma decimal separator and a narrow no-break space for thousands.
const normalise = (s: string) => s.replace(/ | /g, " ");

test("formats euro amounts in Finnish locale", () => {
  expect(normalise(eur("1234.56"))).toBe("1 234,56 €");
  expect(normalise(eur("-7.00"))).toBe("-7,00 €");
  expect(normalise(eur("0.00"))).toBe("0,00 €");
});

test("formats large amounts with grouping", () => {
  expect(normalise(eur("1234567.89"))).toBe("1 234 567,89 €");
});

test("trims trailing zeros from quantities but keeps meaningful decimals", () => {
  expect(normalise(qty("100.000000"))).toBe("100");
  expect(normalise(qty("12.345600"))).toBe("12,3456");
});

// Intl.NumberFormat('fi-FI', ...) renders negatives with U+2212 (MINUS
// SIGN), not ASCII hyphen-minus -- verified directly against this
// project's Bun/ICU build. Regression test for the normalisation that
// keeps every formatter's output plain ASCII on the sign.
test("normalises the Unicode minus sign to ASCII for negative quantities", () => {
  expect(qty("-3.500000")).toBe("-3,5");
  expect(qty("-3.500000").includes("−")).toBe(false);
});

test("formats percentages from a decimal ratio", () => {
  expect(normalise(pct(0.0734))).toBe("+7,34 %");
  expect(normalise(pct(-0.12))).toBe("-12,00 %");
  expect(normalise(pct(0))).toBe("0,00 %");
});

test("formats ISO dates the Finnish way", () => {
  expect(fiDate("2025-06-02")).toBe("2.6.2025");
});
