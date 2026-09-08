import { describe, expect, test } from "vitest";

import { OP_STATEMENT_RECIPE } from "./op-reference.ts";
import { mayBacktrackForever } from "./pattern-safety.ts";

/** The shapes the check has always refused. None of them may start passing. */
const CLASSIC = [
  "^(a+)+$",
  "(a|a)*$",
  String.raw`(\d+)+$`,
  "([a-z]+)*$",
  "(a+)+b",
  "(a*)*",
  "(a|aa)+",
  "^(x|xy|xz)+$",
  "^(?:a+)+$",
];

/**
 * Exponential patterns an earlier check accepted: it looked one level down,
 * so any group boundary between the outer repetition and the inner quantifier
 * hid it. Each of these doubles its run time every two input characters.
 */
const NESTED = ["^(?:(a+))+$", "^((a)+)+$", String.raw`^([a-z]+\s?)+$`, String.raw`^(\w+\s?)*$`];

/** Every pattern the reference recipe is made of, flattened. */
const referencePatterns = (): string[] => [
  ...OP_STATEMENT_RECIPE.skip,
  OP_STATEMENT_RECIPE.recordStart,
  ...OP_STATEMENT_RECIPE.continuation,
  ...Object.values(OP_STATEMENT_RECIPE.header),
];

describe("mayBacktrackForever", () => {
  test.each(CLASSIC)("still refuses %s", (pattern) => {
    expect(mayBacktrackForever(pattern)).toBe(true);
  });

  test.each(NESTED)("refuses %s, whose quantifier hides inside another group", (pattern) => {
    expect(mayBacktrackForever(pattern)).toBe(true);
  });

  test.each(referencePatterns())("accepts the reference recipe's %s", (pattern) => {
    expect(mayBacktrackForever(pattern)).toBe(false);
  });

  test.each([
    String.raw`^\d{1,3}(?:[  ]\d{3})*,\d{2}$`,
    String.raw`^[A-Z]{2}\d{2}(\s\d{4})+$`,
    String.raw`^Eräpäivä\n(?:.*\n)*?\d{1,2}\.\d{1,2}\.\d{4}$`,
    String.raw`^(?:Tilinumero|BIC|Viesti)(?=\s|$)`,
    String.raw`^(?:\s+[A-ZÄÖÅ][A-ZÄÖÅ.-]*)*$`,
    String.raw`^(\d{6}\*+\d{4}|MF NRO|OSTOPVM)`,
  ])("accepts the honest pattern %s", (pattern) => {
    expect(mayBacktrackForever(pattern)).toBe(false);
  });
});
