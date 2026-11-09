import { describe, expect, test } from "vitest";

import { bumpX } from "./curve.ts";

describe("bumpX", () => {
  test("leaves and arrives horizontally, which is what makes a ribbon readable", () => {
    expect(
      bumpX.line([
        [0, 0],
        [100, 50],
      ]),
    ).toBe("M0,0C50,0 50,50 100,50");
  });

  test("draws one cubic per gap", () => {
    const path = bumpX.line([
      [0, 0],
      [100, 50],
      [200, 10],
    ]);
    expect(path.match(/C/g)).toHaveLength(2);
  });

  test("rounds to two decimals rather than emitting float noise", () => {
    expect(
      bumpX.line([
        [0, 0],
        [1 / 3, 1 / 3],
      ]),
    ).toBe("M0,0C0.17,0 0.17,0.33 0.33,0.33");
  });

  test("is empty for no points at all", () => {
    expect(bumpX.line([])).toBe("");
    expect(bumpX.area([], [])).toBe("");
  });

  test("closes an area by walking its lower edge back", () => {
    const path = bumpX.area(
      [
        [0, 0],
        [100, 0],
      ],
      [
        [0, 10],
        [100, 10],
      ],
    );

    expect(path.startsWith("M0,0")).toBe(true);
    expect(path.endsWith("Z")).toBe(true);
    expect(path).toContain("L100,10");
  });
});
