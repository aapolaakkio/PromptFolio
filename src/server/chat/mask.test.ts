import { describe, expect, test } from "vitest";

import { maskAccountNumbers } from "./mask.ts";

describe("maskAccountNumbers", () => {
  test.each([
    ["OP 1234567-8", "OP …"],
    ["tiliote FI21 1234 5600 0007 85.csv", "tiliote ….csv"],
    ["Säästö 123456-789", "Säästö …"],
  ])("masks the number in %s", (text, masked) => {
    expect(maskAccountNumbers(text)).toBe(masked);
  });

  test.each([
    "Acme Fund (FI0008800511)",
    "Record 1234567.00 EUR on 2026-11-03",
    "Nordnet (account #12)",
    "op-2026-10.csv",
    "-1234567,50",
  ])("leaves %s alone: ISINs, amounts, dates and ids are not account numbers", (text) => {
    expect(maskAccountNumbers(text)).toBe(text);
  });
});
