import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { eur } from "../lib/format";

import { AllocationChart } from "./AllocationChart";
import { MonthlyFlowChart } from "./MonthlyFlowChart";
import {
  acceptedRange,
  asDate,
  compactEur,
  plotRows,
  pointTip,
  presetWindow,
  TimeSeriesChart,
  within,
} from "./TimeSeriesChart";

/**
 * Rendered, not merely built.
 *
 * `defineChart` accepts a malformed definition and the library throws when the
 * chart mounts: putting a colour scale among the positional ones shipped a
 * chart that typechecked, passed every test, and then rendered "Position
 * scales cannot use reserved ID" in the browser. Only rendering catches that,
 * so these mount each chart through `react-dom/server` -- the same technique
 * `session-gate.test.ts` already uses, with no DOM and no network.
 */
const renders = (element: React.ReactElement): string => renderToStaticMarkup(element);

describe("AllocationChart", () => {
  test("renders a normal portfolio", () => {
    expect(() =>
      renders(
        <AllocationChart
          slices={[
            { key: "stock", label: "Osakkeet", valueEur: "6000.00", weight: 0.6 },
            { key: "fund", label: "Rahastot", valueEur: "4000.00", weight: 0.4 },
          ]}
        />,
      ),
    ).not.toThrow();
  });

  test("renders more holdings than there are colours, by grouping the tail", () => {
    const many = Array.from({ length: 12 }, (_unused, index) => ({
      key: `k${index}`,
      label: `Erä ${index}`,
      valueEur: "100.00",
      weight: 1 / 12,
    }));
    const html = renders(<AllocationChart slices={many} />);

    // Colour stops carrying identity past eight, so the tail becomes one
    // honestly-named group rather than four invented hues.
    expect(html).toContain("Muu (5)");
  });

  test("says so when there is nothing held", () => {
    expect(renders(<AllocationChart slices={[]} />)).toContain("Ei omistuksia");
  });
});

describe("MonthlyFlowChart", () => {
  test("renders a run of months", () => {
    expect(() =>
      renders(
        <MonthlyFlowChart
          months={[
            { month: "2026-01", incomeEur: "3000.00", expensesEur: "2000.00" },
            { month: "2026-02", incomeEur: "3000.00", expensesEur: "2500.00" },
          ]}
        />,
      ),
    ).not.toThrow();
  });

  test("says so when there is no data", () => {
    expect(renders(<MonthlyFlowChart months={[]} />)).toContain("Ei vielä dataa");
  });
});

describe("TimeSeriesChart", () => {
  test("renders a series long enough to offer zoom", () => {
    const points = Array.from({ length: 40 }, (_unused, index) => ({
      date: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
      value: 1000 + index,
    }));

    expect(() => renders(<TimeSeriesChart points={points} label="Arvo" />)).not.toThrow();
  });

  test("renders a series too short to bother zooming", () => {
    expect(() =>
      renders(<TimeSeriesChart points={[{ date: "2026-01-01", value: 1000 }]} label="Arvo" />),
    ).not.toThrow();
  });
});

describe("presetWindow", () => {
  const rows = plotRows([
    { date: "2020-01-01", value: 100 },
    { date: "2024-06-01", value: 200 },
    { date: "2026-01-01", value: 300 },
    { date: "2026-08-01", value: 400 },
  ]);

  test("spans everything when no preset is chosen", () => {
    const window = presetWindow(rows, null);
    expect(within(rows, window)).toHaveLength(4);
  });

  test("counts back from the most recent point, not from today", () => {
    // A ledger whose last price is months old would otherwise show an empty
    // chart for every preset.
    expect(within(rows, presetWindow(rows, 12)).map((row) => row.value)).toEqual([300, 400]);
  });

  test("keeps a longer preset's earlier points", () => {
    expect(within(rows, presetWindow(rows, 36)).map((row) => row.value)).toEqual([200, 300, 400]);
  });

  test("never starts before the first point there is", () => {
    // The axis is pinned to this window, so a start before the data would draw
    // empty plot at the left edge.
    expect(presetWindow(rows, 600).start).toBe(rows[0]!.at);
  });

  test("handles an empty series without inventing a span", () => {
    expect(presetWindow([], 12)).toEqual({ start: 0, end: 0 });
  });
});

describe("pointTip", () => {
  test("reads the semantic values, not the pixels they were painted at", () => {
    // The bug it exists to prevent: `x`/`y` are screen coordinates, so a
    // tooltip built from them shows a plausible date and a plausible euro
    // figure, both wrong -- which is the worst way for a chart to be wrong.
    // Built from the app's own formatter rather than a typed literal: the
    // Finnish locale groups with a non-breaking space, which is invisible in a
    // diff and makes a hand-typed expectation fail for the wrong reason.
    expect(pointTip({ xValue: Date.UTC(2026, 7, 30), yValue: 1234.5 })).toBe(
      `30.8.2026: ${eur("1234.50")}`,
    );
  });
});

describe("acceptedRange", () => {
  const range = { start: 10, end: 20 };

  test("ignores a preview, so the chart does not redraw under the drag", () => {
    // Accepting previews re-filtered the data on every pointer move, which is
    // what made the selection impossible to finish.
    expect(acceptedRange(range, "preview")).toBeUndefined();
  });

  test("ignores a cancelled drag", () => {
    expect(acceptedRange(range, "cancel")).toBeUndefined();
  });

  test("takes a committed range", () => {
    expect(acceptedRange(range, "commit")).toEqual(range);
  });

  test("treats a click as clearing the window, not selecting nothing", () => {
    expect(acceptedRange({ start: 10, end: 10 }, "commit")).toBeNull();
  });
});
