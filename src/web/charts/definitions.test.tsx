import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { eur } from "../lib/format.ts";

import { AllocationChart } from "./AllocationChart.tsx";
import { CategoryTrendChart, trendRows } from "./CategoryTrendChart.tsx";
import { barsFor, HoldingsChart, holdingTip } from "./HoldingsChart.tsx";
import { MonthlyFlowChart } from "./MonthlyFlowChart.tsx";
import {
  acceptedRange,
  asDate,
  compactEur,
  plotRows,
  pointTip,
  presetWindow,
  TimeSeriesChart,
  within,
} from "./TimeSeriesChart.tsx";

/** Rendered via `react-dom/server`, not merely built: `defineChart` accepts a malformed definition and the library throws only on mount. */
const renders = (element: React.ReactElement): string => renderToStaticMarkup(element);

describe("AllocationChart", () => {
  test("renders a normal portfolio", () => {
    expect(() =>
      renders(
        <AllocationChart
          slices={[
            { key: "stock", label: "Shares", valueEur: "6000.00", weight: 0.6 },
            { key: "fund", label: "Funds", valueEur: "4000.00", weight: 0.4 },
          ]}
        />,
      ),
    ).not.toThrow();
  });

  test("renders more holdings than there are colours, by grouping the tail", () => {
    const many = Array.from({ length: 12 }, (_unused, index) => ({
      key: `k${index}`,
      label: `Item ${index}`,
      valueEur: "100.00",
      weight: 1 / 12,
    }));
    const html = renders(<AllocationChart slices={many} />);

    expect(html).toContain("Other (5)");
  });

  test("says so when there is nothing held", () => {
    expect(renders(<AllocationChart slices={[]} />)).toContain("No holdings");
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
    expect(renders(<MonthlyFlowChart months={[]} />)).toContain("No data yet");
  });
});

describe("TimeSeriesChart", () => {
  test("renders a series long enough to offer zoom", () => {
    const points = Array.from({ length: 40 }, (_unused, index) => ({
      date: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
      value: 1000 + index,
    }));

    expect(() => renders(<TimeSeriesChart points={points} label="Value" />)).not.toThrow();
  });

  test("renders a series too short to bother zooming", () => {
    expect(() =>
      renders(<TimeSeriesChart points={[{ date: "2026-01-01", value: 1000 }]} label="Value" />),
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
    expect(within(rows, presetWindow(rows, 12)).map((row) => row.value)).toEqual([300, 400]);
  });

  test("keeps a longer preset's earlier points", () => {
    expect(within(rows, presetWindow(rows, 36)).map((row) => row.value)).toEqual([200, 300, 400]);
  });

  test("never starts before the first point there is", () => {
    expect(presetWindow(rows, 600).start).toBe(rows[0]!.at);
  });

  test("handles an empty series without inventing a span", () => {
    expect(presetWindow([], 12)).toEqual({ start: 0, end: 0 });
  });
});

describe("pointTip", () => {
  test("reads the semantic values, not the pixels they were painted at", () => {
    // `x`/`y` are screen coordinates: a tooltip built from them shows a plausible but wrong date and amount.
    expect(pointTip({ xValue: Date.UTC(2026, 7, 30), yValue: 1234.5 })).toBe(
      `30/08/2026: ${eur("1234.50")}`,
    );
  });
});

describe("acceptedRange", () => {
  const range = { start: 10, end: 20 };

  test("ignores a preview, so the chart does not redraw under the drag", () => {
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

describe("HoldingsChart", () => {
  const holdings = [
    { instrumentId: 1, name: "Small", valueEur: "100.00", unrealisedEur: "-10.00" },
    { instrumentId: 2, name: "Large", valueEur: "900.00", unrealisedEur: "50.00" },
    { instrumentId: 3, name: "Unpriced", valueEur: null, unrealisedEur: null },
  ];

  test("draws the largest holding first, so concentration is the first thing seen", () => {
    expect(barsFor(holdings).map((row) => row.name)).toEqual(["Large", "Small"]);
  });

  test("leaves out a holding that could not be valued rather than drawing it at zero", () => {
    expect(barsFor(holdings).some((row) => row.name === "Unpriced")).toBe(false);
  });

  test("a hovered bar says what it is worth and what of that is gain", () => {
    expect(holdingTip({ name: "Large", value: 900, gain: 50 })).toContain("+");
    expect(holdingTip({ name: "Unknown", value: 900, gain: null })).not.toContain("(");
  });

  test("renders", () => {
    expect(() => renders(<HoldingsChart holdings={holdings} />)).not.toThrow();
  });

  test("says so when nothing can be valued", () => {
    expect(
      renders(
        <HoldingsChart
          holdings={[{ instrumentId: 1, name: "X", valueEur: null, unrealisedEur: null }]}
        />,
      ),
    ).toContain("No priced holdings");
  });
});

describe("CategoryTrendChart", () => {
  const months = [
    { month: "2026-01", byCategory: { groceries: "300.00", restaurants: "100.00" } },
    { month: "2026-02", byCategory: { groceries: "350.00", restaurants: "80.00" } },
  ];
  const categories = [
    { key: "groceries", label: "Groceries" },
    { key: "restaurants", label: "Restaurants" },
  ];

  test("draws one band per category per month", () => {
    expect(trendRows(months, categories).rows).toHaveLength(4);
  });

  test("folds the ninth category and beyond into one honest group", () => {
    const many = Array.from({ length: 12 }, (_unused, index) => ({
      key: `k${index}`,
      label: `Item ${index}`,
    }));
    const { shown } = trendRows(
      [{ month: "2026-01", byCategory: Object.fromEntries(many.map((c) => [c.key, "10.00"])) }],
      many,
    );

    expect(shown).toHaveLength(8);
    expect(shown.at(-1)?.label).toBe("Other (5)");
  });

  test("sums the folded categories rather than dropping them", () => {
    const many = Array.from({ length: 10 }, (_unused, index) => ({
      key: `k${index}`,
      label: `Item ${index}`,
    }));
    const { rows } = trendRows(
      [{ month: "2026-01", byCategory: Object.fromEntries(many.map((c) => [c.key, "10.00"])) }],
      many,
    );

    // Three folded categories at 10.00 each: the group carries 30.00.
    expect(rows.find((row) => row.category.startsWith("Other"))?.amount).toBe(30);
  });

  test("renders", () => {
    expect(() =>
      renders(<CategoryTrendChart months={months} categories={categories} />),
    ).not.toThrow();
  });

  test("says so when there is nothing to show", () => {
    expect(renders(<CategoryTrendChart months={[]} categories={[]} />)).toContain("No data yet");
  });
});

describe("axis labels", () => {
  test("a tick reads as a date, never as the milliseconds behind it", () => {
    expect(asDate(Date.UTC(2026, 7, 30))).toBe("30/08/2026");
  });

  test("thousands are compacted, so a five-figure axis stays readable", () => {
    expect(compactEur(50_000)).toBe("50 k€");
    expect(compactEur(0)).toBe("0 €");
  });

  test("a negative tick uses the same minus sign as the tables", () => {
    expect(compactEur(-12_400)).toBe("-12 k€");
  });
});

describe("a trend over a single month", () => {
  test("says why there is nothing to draw rather than drawing an empty plot", () => {
    const html = renders(
      <CategoryTrendChart
        months={[{ month: "2026-08", byCategory: { groceries: "300.00" } }]}
        categories={[{ key: "groceries", label: "Groceries" }]}
      />,
    );

    expect(html).toContain("at least two months");
  });
});
