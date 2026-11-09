import { expect, test } from "vitest";

import { EUR, formatMoney, parseMoney } from "./money.ts";
import { sumYearlyCosts, yearlyCostEur } from "./fund-costs.ts";

test("yearly cost is value x basis points / 10 000", () => {
  expect(formatMoney(yearlyCostEur(parseMoney("12500.00", EUR), 20))).toBe("25.00");
  expect(formatMoney(yearlyCostEur(parseMoney("333.33", EUR), 150))).toBe("5.00");
});

test("the sum skips unknown fees and is zero for none", () => {
  expect(
    sumYearlyCosts([
      { yearlyCostEur: "25.00" },
      { yearlyCostEur: null },
      { yearlyCostEur: "5.50" },
    ]),
  ).toBe("30.50");
  expect(sumYearlyCosts([{ yearlyCostEur: null }])).toBe("0.00");
});
