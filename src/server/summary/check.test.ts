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
    expect(isCheckedSummary("The holiday shoulder season.", FACTS)).toBe(true);
  });
});

describe("sentence-final decimals and dates", () => {
  const facts = JSON.stringify({ x: "5.5", y: "99.9" }, null, 2);
  test("an invented decimal at the end of a sentence is rejected", () => {
    expect(isCheckedSummary("Value rose 5.6.", facts)).toBe(false);
    expect(isCheckedSummary("It is up 99.8.", facts)).toBe(false);
  });
  test("a fact at the end of a sentence is accepted", () => {
    expect(isCheckedSummary("Value rose 5.5.", facts)).toBe(true);
  });
  test("an invented long number and a printed date are rejected", () => {
    expect(isCheckedSummary("Ref 123456789 noted.", facts)).toBe(false);
    expect(isCheckedSummary("On 2026-11-03 it moved.", facts)).toBe(false);
    expect(isCheckedSummary("On 3.11.2026 it moved.", facts)).toBe(false);
    expect(isCheckedSummary("On 3.11. it moved.", facts)).toBe(false);
  });
});

describe("direction", () => {
  const facts = JSON.stringify(
    {
      totalValueEur: "1100.00",
      netDepositsEur: "500.00",
      changeExcludingDepositsEur: "-100.00",
      changePct: "-9.3",
      changeDirection: "down",
      movers: [{ name: "Alpha", changeEur: "20.00", changePct: "2.0", direction: "up" }],
    },
    null,
    2,
  );
  test("a negative fact described as growth is rejected", () => {
    expect(isCheckedSummary("Your portfolio is up 100.00 euros.", facts)).toBe(false);
    expect(isCheckedSummary("Your portfolio rose 9.3%.", facts)).toBe(false);
  });
  test("a negative fact described as a fall is accepted", () => {
    expect(isCheckedSummary("Your portfolio fell 100.00 euros.", facts)).toBe(true);
    expect(isCheckedSummary("Your portfolio is down 9.3%.", facts)).toBe(true);
  });
  test("a positive fact described as a fall is rejected, as growth is accepted", () => {
    expect(isCheckedSummary("Alpha fell 20.00 euros.", facts)).toBe(false);
    expect(isCheckedSummary("Alpha rose 20.00 euros.", facts)).toBe(true);
  });
  test("a figure that is not a change needs no direction word", () => {
    expect(isCheckedSummary("Worth 1100.00 euros with 500.00 deposited.", facts)).toBe(true);
  });
});

describe("normalising and word lists", () => {
  test("full-width digits are read as digits", () => {
    expect(isCheckedSummary("Rose １２３４．５７ euros.", FACTS)).toBe(false);
    expect(isCheckedSummary("Rose １２．３ percent.", FACTS)).toBe(true);
  });
  test.each([
    "thirty",
    "hundred",
    "thousand",
    "million",
    "half",
    "twice",
    "double",
    "dozen",
    "couple",
  ])("rejects the number word %s", (word) => {
    expect(isCheckedSummary(`About ${word} euros.`, FACTS)).toBe(false);
  });
  test.each([
    "Consider selling.",
    "You bought it.",
    "It sold well.",
    "Trim the position.",
    "Reduce the fund.",
    "Rebalance now.",
    "I recommend waiting.",
    "You must act.",
    "Add to the position.",
    "Increase your position.",
    "Buying more.",
  ])("rejects advice: %s", (text) => {
    expect(isCheckedSummary(text, FACTS)).toBe(false);
  });
  test("plain increased and reduced stay usable", () => {
    expect(isCheckedSummary("Value increased and costs reduced.", FACTS)).toBe(true);
  });
});
