import { describe, expect, test } from "vitest";

import { OP_STATEMENT_RECIPE } from "./op-reference.ts";
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

  // The reference recipe the model is shown spends 202 characters on one skip
  // alternation, and a statement with more page furniture than OP's needs more.
  test("accepts a skip alternation the size a real statement's furniture takes", () => {
    const words = Array.from({ length: 60 }, (_, at) => `Sana${at}`).join("|");
    const long = { ...valid, skip: [`^(?:${words})(?=\\s|$)`] };

    expect(long.skip[0]!.length).toBeGreaterThan(400);
    expect(parseRecipe(long).skip[0]).toBe(long.skip[0]);
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

  test("accepts a non-breaking space as the thousands separator", () => {
    const nbsp = { ...valid, money: { ...valid.money, thousands: " " } };
    expect(parseRecipe(nbsp).money.thousands).toBe(" ");
  });

  test("refuses a thousands separator equal to the decimal separator", () => {
    const same = { ...valid, money: { ...valid.money, thousands: ".", decimal: "." } };
    expect(() => parseRecipe(same)).toThrow();
  });
});

/**
 * A pattern's run time cannot be bounded once `exec` has been entered, so the
 * shapes that blow up are refused before they are ever compiled into a recipe.
 * `^(a+)+$` is seven characters -- far under the length cap -- and took over
 * two minutes on a 37-character line against a 500 ms budget.
 */
describe("parseRecipe -- catastrophic pattern shapes", () => {
  const withSkip = (pattern: string) => ({ ...valid, skip: [pattern] });

  test("refuses a quantified group whose body is itself quantified", () => {
    expect(() => parseRecipe(withSkip("^(a+)+$"))).toThrow(/jumiin/);
  });

  test("refuses the other classic forms", () => {
    for (const pattern of ["^(a*)*$", "^(a+)*$", String.raw`(\d+)+`, "(?:[a-z]+)+"]) {
      expect(() => parseRecipe(withSkip(pattern))).toThrow(/jumiin/);
    }
  });

  test("refuses a quantified group whose alternatives overlap", () => {
    expect(() => parseRecipe(withSkip("^(a|aa)+$"))).toThrow(/jumiin/);
  });

  test("keeps accepting the patterns real recipes are made of", () => {
    for (const pattern of [
      String.raw`^\d{1,3}(?:[  ]\d{3})*,\d{2}$`,
      String.raw`^[A-Z]{2}\d{2}(\s\d{4})+$`,
      String.raw`^Eräpäivä\n(?:.*\n)*?\d{1,2}\.\d{1,2}\.\d{4}$`,
      "^(?:Tilinumero|BIC|Viesti)(?=\\s|$)",
    ]) {
      expect(() => parseRecipe(withSkip(pattern))).not.toThrow();
    }
  });

  test("accepts the reference recipe unchanged", () => {
    expect(() => parseRecipe(OP_STATEMENT_RECIPE)).not.toThrow();
  });
});

// A layout that prints the date on its own line and the amount several lines
// later -- one bank's savings statement does -- can only name the amount in a
// continuation. Refusing that recipe left no way to describe the file at all.
test("accepts a recipe whose amount is named by a continuation", () => {
  const split = {
    ...valid,
    recordStart: String.raw`^(?<date>\d{4}-\d{2}-\d{2})$`,
    continuation: [String.raw`^[+-] (?<amount>[\d,.]+) EUR`],
  };
  expect(parseRecipe(split).continuation).toHaveLength(1);
});

test("still refuses a recipe that names an amount nowhere", () => {
  const none = {
    ...valid,
    recordStart: String.raw`^(?<date>\d{4}-\d{2}-\d{2})$`,
    continuation: [String.raw`^(?<message>.+)$`],
  };
  expect(() => parseRecipe(none)).toThrow(/amount/);
});
