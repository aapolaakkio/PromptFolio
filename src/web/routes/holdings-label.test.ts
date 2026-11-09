import { describe, expect, test } from "vitest";
import { instrumentLabel } from "./holdings-label.ts";

describe("instrumentLabel", () => {
  test("ISIN, ticker and currency", () => {
    expect(
      instrumentLabel({
        isin: "FI4000567029",
        sourceKey: "FIA1S.HE",
        priceSource: "yahoo",
        currency: "EUR",
        lookupStatus: "ok",
      }),
    ).toBe("FI4000567029 · FIA1S.HE · EUR");
  });

  test("a pending lookup says so", () => {
    expect(
      instrumentLabel({
        isin: "FI4000567029",
        sourceKey: "FI4000567029",
        priceSource: "manual",
        currency: "EUR",
        lookupStatus: "pending",
      }),
    ).toBe("FI4000567029 · haetaan tunnusta · EUR");
  });

  test("a manual price shows no code", () => {
    expect(
      instrumentLabel({
        isin: "FI4000233267",
        sourceKey: "FI4000233267",
        priceSource: "manual",
        currency: "EUR",
        lookupStatus: "ok",
      }),
    ).toBe("FI4000233267 · oma hinta · EUR");
  });

  test("a holding without ISIN leaves it out", () => {
    expect(
      instrumentLabel({
        isin: null,
        sourceKey: "NOKIA.HE",
        priceSource: "yahoo",
        currency: "EUR",
        lookupStatus: "ok",
      }),
    ).toBe("NOKIA.HE · EUR");
  });
});
