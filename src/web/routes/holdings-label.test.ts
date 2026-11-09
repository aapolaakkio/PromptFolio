import { describe, expect, test } from "vitest";
import { instrumentLabel } from "./holdings-label.ts";

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
    ).toBe("FI4000567029 · haetaan tunnusta");
  });

  test("a manual price shows no code", () => {
    expect(
      instrumentLabel({
        isin: "FI4000233267",
        sourceKey: "FI4000233267",
        priceSource: "manual",
        lookupStatus: "ok",
      }),
    ).toBe("FI4000233267 · oma hinta");
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
});
