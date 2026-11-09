import { describe, expect, test } from "vitest";

import { isCheckedSummary } from "./check.ts";

const FACTS = JSON.stringify(
  { changeEur: "1234.56", changePct: "12.3", importsMade: 2, name: "Nordnet Global 50" },
  null,
  2,
);

describe("isCheckedSummary", () => {
  test.each([
    "Your portfolio rose 1,234.56 euros, up 12.3%.",
    "Your portfolio rose 1 234,56 euros.",
    "Up 1234.56 euros (12.3 %). 2 imports were made.",
    "Nordnet Global 50 moved.",
  ])("accepts %s", (text) => {
    expect(isCheckedSummary(text, FACTS)).toBe(true);
  });

  test.each([
    ["a number not in the facts", "Your portfolio rose 1,234.57 euros."],
    ["a part of a printed number", "You made 234 euros."],
    ["a percentage not in the facts", "Up 12.4%."],
    ["a count not in the facts", "3 imports were made."],
    ["a number word", "You made two imports."],
    ["advice to buy", "You could buy more."],
    ["advice to sell", "Sell Nordnet Global 50."],
    ["a should", "You Should check 2 imports."],
    ["more than 120 words", Array.from({ length: 121 }, () => "word").join(" ")],
    ["an empty text", "   "],
  ])("rejects %s", (_name, text) => {
    expect(isCheckedSummary(text, FACTS)).toBe(false);
  });

  test("does not mistake a longer word for a banned one", () => {
    expect(isCheckedSummary("The buyer-neutral holiday shoulder.", FACTS)).toBe(true);
  });
});
