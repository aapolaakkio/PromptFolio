import { describe, expect, test } from "vitest";

import {
  availabilityLabel,
  describeBalance,
  describeImport,
  describeMaturity,
  describeReconciliation,
} from "./cash-view.ts";

describe("describeImport", () => {
  test("names both counts, so a re-import reads as intended rather than doubled", () => {
    expect(describeImport({ inserted: 0, skipped: 5, problems: [] })).toBe(
      "0 new transactions, 5 already imported.",
    );
  });

  test("names payees filled in from a second format", () => {
    expect(describeImport({ inserted: 0, skipped: 12, enriched: 12, problems: [] })).toBe(
      "0 new transactions, 12 already imported, 12 payees filled in.",
    );
  });

  test("names unreadable rows when there were any", () => {
    expect(describeImport({ inserted: 4, skipped: 0, problems: [{}] })).toBe(
      "4 new transactions, 0 already imported, 1 rows could not be read.",
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
    ).toBe("Matches: the transactions explain the whole balance of €2110.29.");
  });

  test("names the opening balance it wrote and the day it belongs to", () => {
    expect(
      describeBalance({
        statedEur: "10000.00",
        derivedFromRowsEur: "2110.29",
        openingBalanceEur: "7889.71",
        openingBalanceDate: "2025-08-31",
      }),
    ).toBe("Opening balance recorded as €7889.71 (2025-08-31); the transactions explain €2110.29.");
  });
});

describe("availabilityLabel", () => {
  test("names the day a deposit frees up", () => {
    expect(availabilityLabel({ locked: true, availableFrom: "2027-06-22" })).toBe(
      "Locked until 2027-06-22",
    );
  });

  test("says the term is unknown rather than implying the money is spendable", () => {
    expect(availabilityLabel({ locked: true, availableFrom: null })).toBe(
      "Locked, maturity date unknown",
    );
  });

  test("ordinary cash is simply available", () => {
    expect(availabilityLabel({ locked: false, availableFrom: null })).toBe("Available");
  });
});

describe("describeReconciliation", () => {
  test("says when an older statement's opening balance was left alone", () => {
    expect(
      describeReconciliation({
        differenceEur: "0.00",
        openingBalanceWritten: false,
        openingBalanceDate: "2024-12-31",
      }),
    ).toContain("left unchanged (2024-12-31)");
  });

  test("warns when the ledger no longer matches the statement", () => {
    const text = describeReconciliation({
      differenceEur: "-655.66",
      openingBalanceWritten: true,
      openingBalanceDate: "2025-08-28",
    });

    expect(text).toContain("NOTE");
    expect(text).toContain("-655.66");
  });
});

describe("describeMaturity", () => {
  test("names the date the statement supplied", () => {
    expect(describeMaturity({ maturityDate: "2027-02-01", maturityConflict: null })).toBe(
      "Maturity date 2027-02-01.",
    );
  });

  test("asks the owner to settle a disagreement rather than picking one", () => {
    const text = describeMaturity({ maturityDate: "2027-12-31", maturityConflict: "2027-02-01" });
    expect(text).toContain("2027-02-01");
    expect(text).toContain("2027-12-31");
    expect(text).toContain("Check which one is right");
  });

  test("says nothing when there is no maturity date in play", () => {
    expect(describeMaturity({ maturityDate: null, maturityConflict: null })).toBeNull();
  });
});
