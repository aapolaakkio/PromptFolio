import { describe, expect, test } from "bun:test";

import {
  availabilityLabel,
  describeBalance,
  describeImport,
  describeMaturity,
  describeReconciliation,
} from "./cash-view";

describe("describeImport", () => {
  test("names both counts, so a re-import reads as intended rather than doubled", () => {
    expect(describeImport({ inserted: 0, skipped: 5, problems: [] })).toBe(
      "0 uutta tapahtumaa, 5 jo tuotua.",
    );
  });

  test("names payees filled in from a second format", () => {
    expect(describeImport({ inserted: 0, skipped: 12, enriched: 12, problems: [] })).toBe(
      "0 uutta tapahtumaa, 12 jo tuotua, 12 täydennettyä saajatietoa.",
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

describe("availabilityLabel", () => {
  test("names the day a deposit frees up", () => {
    expect(availabilityLabel({ locked: true, availableFrom: "2027-06-22" })).toBe(
      "Sidottu 2027-06-22 asti",
    );
  });

  test("says the term is unknown rather than implying the money is spendable", () => {
    expect(availabilityLabel({ locked: true, availableFrom: null })).toBe(
      "Sidottu, eräpäivä ei tiedossa",
    );
  });

  test("ordinary cash is simply available", () => {
    expect(availabilityLabel({ locked: false, availableFrom: null })).toBe("Käytettävissä");
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
    ).toContain("säilytettiin ennallaan (2024-12-31)");
  });

  test("warns when the ledger no longer matches the statement", () => {
    const text = describeReconciliation({
      differenceEur: "-655.66",
      openingBalanceWritten: true,
      openingBalanceDate: "2025-08-28",
    });
    // The likely cause is the same period imported twice in two formats, which
    // nothing else would catch.
    expect(text).toContain("HUOM");
    expect(text).toContain("-655.66");
  });
});

describe("describeMaturity", () => {
  test("names the date the statement supplied", () => {
    expect(describeMaturity({ maturityDate: "2027-02-01", maturityConflict: null })).toBe(
      "Eräpäivä 2027-02-01.",
    );
  });

  test("asks the owner to settle a disagreement rather than picking one", () => {
    const text = describeMaturity({ maturityDate: "2027-12-31", maturityConflict: "2027-02-01" });
    expect(text).toContain("2027-02-01");
    expect(text).toContain("2027-12-31");
    expect(text).toContain("Tarkista");
  });

  test("says nothing when there is no maturity date in play", () => {
    expect(describeMaturity({ maturityDate: null, maturityConflict: null })).toBeNull();
  });
});
