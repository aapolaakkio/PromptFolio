import { describe, expect, test } from "bun:test";

import { bumpX } from "./curve";

describe("bumpX", () => {
  test("leaves and arrives horizontally, which is what makes a ribbon readable", () => {
    // Control points share the segment's midpoint x and each end's own y, so
    // the tangent at both ends is horizontal.
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

    // Starts at the top-left, ends closed; the lower edge is reversed so the
    // outline does not cross through the middle of its own ribbon.
    expect(path.startsWith("M0,0")).toBe(true);
    expect(path.endsWith("Z")).toBe(true);
    expect(path).toContain("L100,10");
  });
});
