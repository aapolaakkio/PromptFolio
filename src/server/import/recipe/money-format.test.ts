import { describe, expect, test } from "vitest";

import type { MoneyFormat } from "./types.ts";
import { readAmount, readTwoColumn } from "./money-format.ts";

const base: MoneyFormat = {
  decimal: ",",
  thousands: " ",
  negative: "leading",
  twoColumn: false,
};

describe("readAmount", () => {
  test("reads a Finnish amount with a non-breaking thousands separator", () => {
    expect(readAmount("2 750,00", base)).toBe(275_000n);
  });

  test("reads a unicode minus as negative", () => {
    expect(readAmount("−25,90", base)).toBe(-2590n);
  });

  test("drops a leading plus", () => {
    expect(readAmount("+1 574,10", base)).toBe(157_410n);
  });

  test("reads a dot decimal with a comma thousands separator", () => {
    expect(readAmount("1,234.56", { ...base, decimal: ".", thousands: "," })).toBe(123_456n);
  });

  test("reads a dot thousands separator without mistaking it for a decimal", () => {
    expect(readAmount("1.234", { ...base, thousands: "." })).toBe(123_400n);
  });

  test("reads a trailing minus", () => {
    expect(readAmount("1 234,56-", { ...base, negative: "trailing" })).toBe(-123_456n);
  });

  test("reads parentheses as negative", () => {
    expect(readAmount("(1 234,56)", { ...base, negative: "parentheses" })).toBe(-123_456n);
  });

  test("reads a debit word as negative", () => {
    const format: MoneyFormat = { ...base, negative: "suffix", debitWords: ["DR", "VELOITUS"] };
    expect(readAmount("1 234,56 DR", format)).toBe(-123_456n);
    expect(readAmount("1 234,56 CR", format)).toBe(123_456n);
  });

  test("strips a currency code named by the format", () => {
    expect(readAmount("1 234,56 EUR", { ...base, strip: ["EUR"] })).toBe(123_456n);
  });

  test("does not strip a stripped word from inside the digits", () => {
    expect(readAmount("1 234,56", { ...base, strip: ["23"] })).toBe(123_456n);
  });

  test("ignores an empty strip entry instead of looping on it", () => {
    expect(readAmount("1 234,56", { ...base, strip: [""] })).toBe(123_456n);
  });

  test("does not flip the sign when a trailing word merely ends with a debit word", () => {
    const format: MoneyFormat = { ...base, negative: "suffix", debitWords: ["D"] };
    expect(readAmount("250,00 CAD", format)).toBe(25_000n);
  });

  test("refuses a leading minus when the format says the minus trails", () => {
    expect(() => readAmount("-1 234,56", { ...base, negative: "trailing" })).toThrow();
  });

  test("refuses a leading minus when the format says parentheses", () => {
    expect(() => readAmount("-1 234,56", { ...base, negative: "parentheses" })).toThrow();
  });

  test("still reads a leading minus when the format says leading", () => {
    expect(readAmount("-1 234,56", base)).toBe(-123_456n);
  });

  test("refuses text that holds no figure", () => {
    expect(() => readAmount("K-MARKET", base)).toThrow();
  });
});

describe("readTwoColumn", () => {
  const format: MoneyFormat = { ...base, twoColumn: true };

  test("a filled debit column is money leaving", () => {
    expect(readTwoColumn("25,90", "", format)).toBe(-2590n);
  });

  test("a filled credit column is money arriving", () => {
    expect(readTwoColumn("", "25,90", format)).toBe(2590n);
  });

  test("refuses a row where both columns are empty", () => {
    expect(() => readTwoColumn("", "", format)).toThrow();
  });
});
