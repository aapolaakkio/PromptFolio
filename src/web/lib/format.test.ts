import { test, expect } from "vitest";
import { eur, qty, pct, share, formatDate, formatDateTime } from "./format.ts";

test("formats euro amounts in en-GB", () => {
  expect(eur("1234.56")).toBe("€1,234.56");
  expect(eur("-7.00")).toBe("-€7.00");
  expect(eur("0.00")).toBe("€0.00");
});

test("formats large amounts with grouping", () => {
  expect(eur("1234567.89")).toBe("€1,234,567.89");
});

test("trims trailing zeros from quantities but keeps meaningful decimals", () => {
  expect(qty("100.000000")).toBe("100");
  expect(qty("12.345600")).toBe("12.3456");
});

test("formats negative quantities with an ASCII minus", () => {
  expect(qty("-3.500000")).toBe("-3.5");
});

test("formats percentages from a decimal ratio", () => {
  expect(pct(0.0734)).toBe("+7.34%");
  expect(pct(-0.12)).toBe("-12.00%");
  expect(pct(0)).toBe("0.00%");
});

test("formats ISO dates as dd/mm/yyyy", () => {
  expect(formatDate("2025-06-02")).toBe("02/06/2025");
});

test("formats an ISO instant with both a date and a time", () => {
  expect(formatDateTime("2026-08-28T10:15:00.000Z")).toMatch(/^\d{2}\/\d{2}\/2026, \d{2}:\d{2}$/);
});

test("formats a share ratio as an unsigned percentage", () => {
  expect(share(0.1523)).toBe("15.23%");
  expect(share(1)).toBe("100.00%");
  expect(share(0)).toBe("0.00%");
  expect(share(0.1523).startsWith("+")).toBe(false);
});
