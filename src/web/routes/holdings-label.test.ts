import { describe, expect, test } from "vitest";
import { chargeLabel, instrumentLabel } from "./holdings-label.ts";

describe("instrumentLabel", () => {
  test("ISIN and ticker", () => {
    expect(
      instrumentLabel({
        isin: "FI4000567029",
        sourceKey: "FIA1S.HE",
        priceSource: "yahoo",
        lookupStatus: "ok",
      }),
    ).toBe("FI4000567029 · FIA1S.HE");
  });

  test("a pending lookup says so", () => {
    expect(
      instrumentLabel({
        isin: "FI4000567029",
        sourceKey: "FI4000567029",
        priceSource: "manual",
        lookupStatus: "pending",
      }),
    ).toBe("FI4000567029 · looking up ticker");
  });

  test("a manual price shows no code", () => {
    expect(
      instrumentLabel({
        isin: "FI4000233267",
        sourceKey: "FI4000233267",
        priceSource: "manual",
        lookupStatus: "ok",
      }),
    ).toBe("FI4000233267 · own price");
  });

  test("a holding without ISIN leaves it out", () => {
    expect(
      instrumentLabel({
        isin: null,
        sourceKey: "NOKIA.HE",
        priceSource: "yahoo",
        lookupStatus: "ok",
      }),
    ).toBe("NOKIA.HE");
  });

  test("a page shows its host and path", () => {
    expect(
      instrumentLabel({
        isin: "FI4000567029",
        sourceKey: "https://www.nordnet.fi/rahastot/lista/x?y=1",
        priceSource: "page",
        lookupStatus: "ok",
      }),
    ).toBe("FI4000567029 · www.nordnet.fi/rahastot/lista/x");
  });
});

test("chargeLabel shows two decimals, and a dash while unknown", () => {
  expect(chargeLabel(20)).toBe("0.20%");
  expect(chargeLabel(150)).toBe("1.50%");
  expect(chargeLabel(null)).toBe("–");
});
