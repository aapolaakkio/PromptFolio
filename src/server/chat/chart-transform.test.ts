import { describe, expect, test } from "vitest";

import { applyTransform, thin, transformedUnit } from "./chart-transform.ts";

const points = [
  { x: "2026-01", y: 200 },
  { x: "2026-02", y: 250 },
  { x: "2026-03", y: 150 },
];
const ys = (transform: Parameters<typeof applyTransform>[1], from = points) =>
  applyTransform(from, transform).points.map((point) => point.y);

describe("applyTransform", () => {
  test("none keeps the values", () => {
    expect(applyTransform(points, "none").points).toEqual(points);
  });

  test("cumulative is a running sum", () => {
    expect(ys("cumulative")).toEqual([200, 450, 600]);
  });

  test("percent change is measured from the first value", () => {
    expect(ys("percent-change-from-start")).toEqual([0, 25, -25]);
  });

  test("index-100 scales the first value to 100", () => {
    expect(ys("index-100")).toEqual([100, 125, 75]);
  });

  test.each([[0], [-100]])("a start of %s is shown as is, with a note", (start) => {
    const from = [
      { x: "a", y: start },
      { x: "b", y: 50 },
    ];
    for (const transform of ["percent-change-from-start", "index-100"] as const) {
      const out = applyTransform(from, transform);
      expect(out.applied).toBe("none");
      expect(out.points).toEqual(from);
      expect(out.note).toMatch(/at or below zero/);
    }
  });

  test("point flags survive a transform", () => {
    const flagged = [{ x: "a", y: 1, estimated: true }];
    expect(applyTransform(flagged, "cumulative").points).toEqual(flagged);
  });

  test("units follow the transform", () => {
    expect(transformedUnit("EUR", "cumulative")).toBe("EUR");
    expect(transformedUnit("EUR", "percent-change-from-start")).toBe("%");
    expect(transformedUnit("EUR", "index-100")).toBe("index");
  });
});

describe("thin", () => {
  test("keeps at most 400 points and always the last", () => {
    const many = Array.from({ length: 1001 }, (_unused, index) => index);
    const out = thin(many);
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out.at(-1)).toBe(1000);
  });
});
