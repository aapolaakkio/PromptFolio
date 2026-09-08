import { describe, expect, test } from "vitest";

import { MAX_PATTERN_LENGTH, parseRecipe } from "./types.ts";

const valid = {
  kind: "bank",
  skip: ["^Tilinumero"],
  recordStart: String.raw`^(?<date>\d{1,2}\.\d{1,2}\.\d{4})\s+(?<amount>[+\-−\d  ,]+)\s+(?<tail>.*)$`,
  continuation: [String.raw`^(?<externalId>[0-9A-Z]{16,})$`],
  restField: "counterparty",
  header: { openingBalance: String.raw`^(?<value>[\d ,]+)\s+Saldo` },
  dateFormat: "d.m.yyyy",
  money: { decimal: ",", thousands: " ", negative: "leading", twoColumn: false },
};

describe("parseRecipe", () => {
  test("accepts a well-formed recipe", () => {
    expect(parseRecipe(valid).kind).toBe("bank");
  });

  test("refuses a recordStart with no date group", () => {
    const noDate = { ...valid, recordStart: String.raw`^(?<amount>\d+)$` };
    expect(() => parseRecipe(noDate)).toThrow(/date/);
  });

  test("refuses a recordStart with neither amount nor a debit/credit pair", () => {
    const noAmount = { ...valid, recordStart: String.raw`^(?<date>\d+)$` };
    expect(() => parseRecipe(noAmount)).toThrow(/amount/);
  });

  test("accepts a debit/credit pair instead of amount", () => {
    const twoColumn = {
      ...valid,
      recordStart: String.raw`^(?<date>\d+)\s+(?<debit>[\d,]*)\s+(?<credit>[\d,]*)$`,
      money: { ...valid.money, twoColumn: true },
    };
    expect(parseRecipe(twoColumn).money.twoColumn).toBe(true);
  });

  test("refuses a pattern longer than the cap", () => {
    const huge = { ...valid, skip: ["x".repeat(MAX_PATTERN_LENGTH + 1)] };
    expect(() => parseRecipe(huge)).toThrow();
  });

  test("refuses a pattern that is not a valid regex", () => {
    expect(() => parseRecipe({ ...valid, skip: ["("] })).toThrow();
  });

  test("refuses an unknown field", () => {
    expect(() => parseRecipe({ ...valid, extra: 1 })).toThrow();
  });
});
