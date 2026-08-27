import { test, expect } from "bun:test";
import {
  parseMoney,
  formatMoney,
  addMoney,
  subMoney,
  negateMoney,
  mulMoney,
  divMoney,
  parseQuantity,
  addQuantity,
  subQuantity,
  isZeroQuantity,
  cmpQuantity,
  formatQuantity,
  parseFxRate,
  toEur,
  zeroMoney,
  money,
} from "./money";

test("parses Finnish and plain decimal strings", () => {
  expect(parseMoney("1 234,56", "EUR").minor).toBe(123456n);
  expect(parseMoney("1234.56", "EUR").minor).toBe(123456n);
  expect(parseMoney("-0,07", "EUR").minor).toBe(-7n);
  expect(parseMoney("12", "EUR").minor).toBe(1200n);
});

test("rejects malformed amounts instead of guessing", () => {
  expect(() => parseMoney("", "EUR")).toThrow();
  expect(() => parseMoney("1,234,567", "EUR")).toThrow();
  expect(() => parseMoney("abc", "EUR")).toThrow();
});

test("formats back without loss", () => {
  expect(formatMoney(parseMoney("1234,56", "EUR"))).toBe("1234.56");
  expect(formatMoney(money(-7n, "EUR"))).toBe("-0.07");
  expect(formatMoney(zeroMoney("EUR"))).toBe("0.00");
});

test("refuses to add across currencies", () => {
  expect(() => addMoney(parseMoney("1", "EUR"), parseMoney("1", "USD"))).toThrow(/currency/i);
});

test("adds and subtracts exactly", () => {
  const a = parseMoney("0,10", "EUR");
  const b = parseMoney("0,20", "EUR");
  expect(formatMoney(addMoney(a, b))).toBe("0.30");
  expect(formatMoney(subMoney(a, b))).toBe("-0.10");
});

test("multiplies price by fractional quantity, half-up", () => {
  const price = parseMoney("12,345", "EUR"); // 12.35 after parse rounding
  expect(formatMoney(price)).toBe("12.35");
  const qty = parseQuantity("3,5");
  expect(formatMoney(mulMoney(parseMoney("10,00", "EUR"), qty))).toBe("35.00");
  expect(formatMoney(mulMoney(parseMoney("0,01", "EUR"), parseQuantity("0,5")))).toBe("0.01");
});

test("divides with explicit rounding mode", () => {
  const m = parseMoney("1,00", "EUR");
  expect(formatMoney(divMoney(m, 3n))).toBe("0.33");
  expect(formatMoney(divMoney(parseMoney("0,05", "EUR"), 2n, "floor"))).toBe("0.02");
  expect(formatMoney(divMoney(parseMoney("0,05", "EUR"), 2n, "half-up"))).toBe("0.03");
});

test("parses fractional fund units at 10^-6 precision", () => {
  expect(parseQuantity("12,3456789").scaled).toBe(12345679n);
  expect(addQuantity(parseQuantity("1,5"), parseQuantity("0,25")).scaled).toBe(1750000n);
});

test("converts USD to EUR at a scaled rate", () => {
  const usd = parseMoney("100,00", "USD");
  const rate = { scaled: 92_000_000n, currency: "USD" as const }; // 1 USD = 0.92 EUR
  const eur = toEur(usd, rate);
  expect(eur.currency).toBe("EUR");
  expect(formatMoney(eur)).toBe("92.00");
});

test("refuses to convert with a rate for the wrong currency", () => {
  const usd = parseMoney("100,00", "USD");
  expect(() => toEur(usd, { scaled: 1n, currency: "EUR" })).toThrow(/currency/i);
});

// --- Additional coverage beyond the brief's verbatim tests ---

test("negates money", () => {
  expect(formatMoney(negateMoney(parseMoney("1,23", "EUR")))).toBe("-1.23");
  expect(formatMoney(negateMoney(parseMoney("-1,23", "EUR")))).toBe("1.23");
});

test("subtracts, compares and zero-checks quantities", () => {
  const a = parseQuantity("1,5");
  const b = parseQuantity("0,25");
  expect(isZeroQuantity(subQuantity(a, a))).toBe(true);
  expect(isZeroQuantity(a)).toBe(false);
  expect(cmpQuantity(a, b)).toBe(1);
  expect(cmpQuantity(b, a)).toBe(-1);
  expect(cmpQuantity(a, a)).toBe(0);
  expect(formatQuantity(subQuantity(a, b))).toBe("1.250000");
});

test("formats quantities at 10^-6 precision", () => {
  expect(formatQuantity(parseQuantity("3,5"))).toBe("3.500000");
  expect(formatQuantity(parseQuantity("-0,000001"))).toBe("-0.000001");
});

test("parses fx rates at 10^-8 precision", () => {
  const rate = parseFxRate("0,92", "USD");
  expect(rate.scaled).toBe(92_000_000n);
  expect(rate.currency).toBe("USD");
});

test("divMoney rejects division by zero", () => {
  expect(() => divMoney(parseMoney("1,00", "EUR"), 0n)).toThrow();
});

test("floor rounding on negative amounts rounds toward negative infinity", () => {
  const m = money(-5n, "EUR");
  expect(formatMoney(divMoney(m, 2n, "floor"))).toBe("-0.03");
  expect(formatMoney(divMoney(m, 2n, "half-up"))).toBe("-0.03");
  expect(formatMoney(divMoney(money(-4n, "EUR"), 2n, "floor"))).toBe("-0.02");
});
