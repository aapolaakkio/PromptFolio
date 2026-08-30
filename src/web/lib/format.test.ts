import { test, expect } from "vitest";
import { eur, qty, pct, share, fiDate, fiDateTime } from "./format.ts";

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

// Used for an import's `createdAt`, which (unlike fiDate's bare YYYY-MM-DD trade
// dates) is a full ISO 8601 instant -- proves the date AND time both come through,
// without pinning down the exact glyphs (the reader's own local time zone shifts the
// hour, and this project deliberately never "corrects" real Intl output -- see
// format.ts's own toAsciiMinus comment for the same principle applied to the sign).
test("formats an ISO instant with both a Finnish date and a time", () => {
  const formatted = fiDateTime("2026-08-28T10:15:00.000Z");
  expect(formatted).toMatch(/^28\.8\.2026 klo \d{1,2}\.\d{2}$/);
});

// share() is used for a holding's/slice's `weight` -- a proportion, not a
// gain/loss -- so unlike pct() it never prefixes a "+" on a positive ratio.
test("formats a share ratio as an unsigned Finnish percentage", () => {
  expect(normalise(share(0.1523))).toBe("15,23 %");
  expect(normalise(share(1))).toBe("100,00 %");
  expect(normalise(share(0))).toBe("0,00 %");
  expect(share(0.1523).startsWith("+")).toBe(false);
});
