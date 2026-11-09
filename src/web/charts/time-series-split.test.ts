import { describe, expect, test } from "vitest";

import { plotRows, splitEstimated } from "./TimeSeriesChart.tsx";

const rows = plotRows([
  { date: "2026-01-01", value: 100, estimated: true },
  { date: "2026-01-02", value: 100, estimated: true },
  { date: "2026-01-03", value: 130 },
  { date: "2026-01-04", value: 135 },
]);

describe("splitEstimated", () => {
  test("draws days valued at cost apart from days valued at real prices", () => {
    const { real, estimate } = splitEstimated(rows);
    expect(real.map((row) => row.value)).toEqual([130, 135]);
    expect(estimate.map((row) => row.value)).toEqual([100, 100, 130]);
  });

  test("a series priced throughout has no estimate line at all", () => {
    const priced = rows.map((row) => ({ ...row, estimated: false }));
    expect(splitEstimated(priced).estimate).toEqual([]);
  });
});
