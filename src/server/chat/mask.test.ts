import { describe, expect, test } from "vitest";

import { maskAccountNumbers, maskForFileSample } from "./mask.ts";

describe("maskAccountNumbers", () => {
  test.each([
    ["OP 1234567-8", "OP …"],
    ["tiliote FI21 1234 5600 0007 85.csv", "tiliote ….csv"],
    ["Säästö 123456-789", "Säästö …"],
    ["tili_FI2112345600000785", "tili_…"],
    ["fi21 1234 5600 0007 85", "…"],
    ["FI21_1234_5600_0007_85", "…"],
    ["GB29 NWBK 6016 1331 9268 19", "…"],
    ["Tili A1234567", "Tili A…"],
    ["ref#1234567", "ref#…"],
    ["v.1234567", "v.…"],
    ["123456_789", "…"],
    ["Matti 010190-123A", "Matti …"],
    ["Born 010203A123B", "Born …"],
    ["write to matti.meikalainen@example.fi now", "write to … now"],
    ["Card 4920 **** **** 1234", "Card …"],
    ["call +358 40 123 45 67", "call …"],
    ["Not an ISIN FI0008800512", "Not an ISIN …"],
    ["AB12 some 1234567 here", "… here"],
    ["0.1234567 and 12,3456789", "0.1234567 and 12,3456789"],
  ])("masks the number in %s", (text, masked) => {
    expect(maskAccountNumbers(text)).toBe(masked);
  });

  test.each([
    "Acme Fund (FI0008800511)",
    "FI0008800511 ACME Fund",
    "Record 1234567.00 EUR on 2026-11-03",
    "From 2026-11-03 2026-11-10",
    "Nordnet (account #12)",
    "op-2026-10.csv",
    "-1234567,50",
    "AB12 some word here",
  ])("leaves %s alone: ISINs, amounts, dates and ids are not account numbers", (text) => {
    expect(maskAccountNumbers(text)).toBe(text);
  });
});

describe("maskForFileSample", () => {
  test("keeps the layout of a file row and hides what identifies the owner", () => {
    expect(
      maskForFileSample(
        "03.11.2026;FI21 1234 5600 0007 85;Matti 010190-123A;-1 234,56;FI0008800511\t1234567-8",
      ),
    ).toBe("03.11.2026;xx00 0000 0000 0000 00;Matti 000000-000x;-1 234,56;FI0008800511\t0000000-0");
  });

  test("never reaches across a tab or a line break", () => {
    expect(maskForFileSample("FI21\t1234\n5600 1")).toBe("FI21\t1234\n5600 1");
  });
});
