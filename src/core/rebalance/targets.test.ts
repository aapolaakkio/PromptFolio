import { describe, expect, test } from "vitest";

import { BASIS_POINTS, checkTargets } from "./targets.ts";

describe("checkTargets", () => {
  test("accepts a set summing to 100 %", () => {
    expect(
      checkTargets([
        { key: "stock", weightBp: 6000 },
        { key: "fund", weightBp: 4000 },
      ]),
    ).toBeNull();
  });

  test("refuses a set that does not sum to 100 %, and says what it sums to", () => {
    // Refused, not normalised: 90 % means a forgotten slice.
    const error = checkTargets([
      { key: "stock", weightBp: 6000 },
      { key: "fund", weightBp: 3000 },
    ]);

    expect(error?.totalBp).toBe(9000);
    expect(error?.message).toContain("90 %");
  });

  test("refuses a negative weight even when the set still sums to 100 %", () => {
    const error = checkTargets([
      { key: "stock", weightBp: 11000 },
      { key: "fund", weightBp: -1000 },
    ]);

    expect(error).not.toBeNull();
    expect(error?.message).toContain("fund");
  });

  test("refuses an empty set rather than reading it as no targets", () => {
    // No targets is stored as no rows; an empty set is a caller that lost them.
    expect(checkTargets([])).not.toBeNull();
  });

  test("BASIS_POINTS is one hundred per cent", () => {
    expect(checkTargets([{ key: "all", weightBp: BASIS_POINTS }])).toBeNull();
  });
});
