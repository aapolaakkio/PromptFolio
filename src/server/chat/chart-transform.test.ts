import { describe, expect, test } from "vitest";

import { applyTransform, transformedUnit } from "./chart-transform.ts";

const points = [
  { x: "2026-01", y: 200 },
  { x: "2026-02", y: 250 },
  { x: "2026-03", y: 150 },
];

describe("applyTransform", () => {
  test("none keeps the values", () => {
    expect(applyTransform(points, "none")).toEqual(points);
  });

  test("cumulative is a running sum", () => {
    expect(applyTransform(points, "cumulative").map((point) => point.y)).toEqual([200, 450, 600]);
  });

  test("percent change is measured from the first value", () => {
    expect(applyTransform(points, "percent-change-from-start").map((point) => point.y)).toEqual([
      0, 25, -25,
    ]);
  });

  test("index-100 scales the first value to 100", () => {
    expect(applyTransform(points, "index-100").map((point) => point.y)).toEqual([100, 125, 75]);
  });

  test("a start of zero cannot be a base", () => {
    expect(() => applyTransform([{ x: "a", y: 0 }], "index-100")).toThrow(/starts at zero/);
  });

  test("units follow the transform", () => {
    expect(transformedUnit("EUR", "cumulative")).toBe("EUR");
    expect(transformedUnit("EUR", "percent-change-from-start")).toBe("%");
    expect(transformedUnit("EUR", "index-100")).toBe("index");
  });
});
