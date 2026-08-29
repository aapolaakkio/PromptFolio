import { describe, expect, test } from "bun:test";

import { describeBalance, describeImport } from "./cash-view";

describe("describeImport", () => {
  test("names both counts, so a re-import reads as intended rather than doubled", () => {
    expect(describeImport({ inserted: 0, skipped: 5, problems: [] })).toBe(
      "0 uutta tapahtumaa, 5 jo tuotua.",
    );
  });

  test("names unreadable rows when there were any", () => {
    expect(describeImport({ inserted: 4, skipped: 0, problems: [{}] })).toBe(
      "4 uutta tapahtumaa, 0 jo tuotua, 1 riviä ei voitu lukea.",
    );
  });
});

describe("describeBalance", () => {
  test("says plainly when the ledger already agrees with the bank", () => {
    expect(
      describeBalance({
        statedEur: "2110.29",
        derivedFromRowsEur: "2110.29",
        openingBalanceEur: "0.00",
        openingBalanceDate: "2025-08-31",
      }),
    ).toBe("Täsmää: tapahtumat selittävät koko saldon 2110.29 €.");
  });

  test("names the opening balance it wrote and the day it belongs to", () => {
    expect(
      describeBalance({
        statedEur: "10000.00",
        derivedFromRowsEur: "2110.29",
        openingBalanceEur: "7889.71",
        openingBalanceDate: "2025-08-31",
      }),
    ).toBe("Alkusaldoksi kirjattiin 7889.71 € (2025-08-31); tapahtumat selittävät 2110.29 €.");
  });
});
