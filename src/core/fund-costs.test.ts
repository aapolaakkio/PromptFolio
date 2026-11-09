import { expect, test } from "vitest";

import { EUR, formatMoney, parseMoney } from "./money.ts";
import { yearlyCostSummary, yearlyCostEur } from "./fund-costs.ts";

test("yearly cost is value x basis points / 10 000", () => {
  expect(formatMoney(yearlyCostEur(parseMoney("12500.00", EUR), 20))).toBe("25.00");
  expect(formatMoney(yearlyCostEur(parseMoney("333.33", EUR), 150))).toBe("5.00");
});

test("the summary adds known fees, counts them, and is null when none is known", () => {
  expect(
    yearlyCostSummary([
      { yearlyCostEur: "25.00" },
      { yearlyCostEur: null },
      { yearlyCostEur: "5.50" },
    ]),
  ).toEqual({ totalEur: "30.50", known: 2, total: 3 });
  expect(yearlyCostSummary([{ yearlyCostEur: null }])).toEqual({
    totalEur: null,
    known: 0,
    total: 1,
  });
  expect(yearlyCostSummary([])).toEqual({ totalEur: null, known: 0, total: 0 });
});
