import { test, expect } from "bun:test";

import { dateTip, moneyTip, shareTip } from "./interactions";

test("a hovered figure reads exactly as the same figure in a table", () => {
  // Two formatting paths for one number is two chances to disagree, and the
  // one under the cursor is the one a person acts on.
  expect(moneyTip("Arvo", "1234.50")).toBe(
    `Arvo: ${new Intl.NumberFormat("fi-FI", {
      style: "currency",
      currency: "EUR",
    })
      .format(1234.5)
      .replace(/−/g, "-")}`,
  );
});

test("a date tooltip uses the same Finnish form as the tables", () => {
  expect(dateTip("2026-08-30")).toBe("30.8.2026");
});

test("a share tooltip keeps one decimal and a decimal comma", () => {
  expect(shareTip("Osuus", 0.1523)).toBe("Osuus: 15,2 %");
});
