import { describe, expect, test } from "vitest";

import { OP_STATEMENT_RECIPE } from "./op-reference.ts";
import { hasManyWildcards, mayBacktrackForever } from "./pattern-safety.ts";

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

const NESTED = ["^(?:(a+))+$", "^((a)+)+$", String.raw`^([a-z]+\s?)+$`, String.raw`^(\w+\s?)*$`];

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

describe("hasManyWildcards", () => {
  test.each([
    String.raw`.*a.*b`,
    String.raw`[\s\S]*?x[^}]+y`,
    ".+a.*?",
    String.raw`[\w\W]*a[\W\w]*b`,
    String.raw`[\d\D]*a[\D\d]+b`,
    String.raw`[\S\s]*a[^]*b`,
    String.raw`.{0,}a.{1,}b`,
    String.raw`.{2,}a.*b`,
    String.raw`(?:.|\n)*a(?:.|\n)*b`,
    String.raw`(?:.|\n)*a.*b`,
  ])("refuses %s", (p) => {
    expect(hasManyWildcards(p)).toBe(true);
  });
  test.each([
    String.raw`a.*b`,
    String.raw`[^}]*?x\d+\.*`,
    String.raw`[a.+]+x[.*]+`,
    String.raw`\s*\S+`,
  ])("allows %s", (p) => {
    expect(hasManyWildcards(p)).toBe(false);
  });
});
