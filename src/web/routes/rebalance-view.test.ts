import { describe, expect, test } from "vitest";

import { targetTotal } from "./rebalance-view.ts";

describe("targetTotal", () => {
  test("adds the weights being typed, so the running total is what is on screen", () => {
    expect(
      targetTotal([
        { key: "a", weightPercent: "60" },
        { key: "b", weightPercent: "40" },
      ]),
    ).toBe("100.00");
  });

  test("handles a decimal comma, which is what many European keyboards produce", () => {
    expect(
      targetTotal([
        { key: "a", weightPercent: "33,33" },
        { key: "b", weightPercent: "66,67" },
      ]),
    ).toBe("100.00");
  });

  test("treats a blank field as nothing rather than as invalid", () => {
    // A half-filled form is a normal state while typing, not an error.
    expect(
      targetTotal([
        { key: "a", weightPercent: "" },
        { key: "b", weightPercent: "40" },
      ]),
    ).toBe("40.00");
  });

  test("counts a total under one per cent", () => {
    expect(targetTotal([{ key: "a", weightPercent: "0,5" }])).toBe("0.50");
  });
});
