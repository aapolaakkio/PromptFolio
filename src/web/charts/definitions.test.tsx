import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { eur } from "../lib/format";

import { AllocationChart } from "./AllocationChart";
import { CategoryTrendChart, trendRows } from "./CategoryTrendChart";
import { barsFor, HoldingsChart, holdingTip } from "./HoldingsChart";
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

describe("HoldingsChart", () => {
  const holdings = [
    { instrumentId: 1, name: "Pieni", valueEur: "100.00", unrealisedEur: "-10.00" },
    { instrumentId: 2, name: "Suuri", valueEur: "900.00", unrealisedEur: "50.00" },
    { instrumentId: 3, name: "Hinnaton", valueEur: null, unrealisedEur: null },
  ];

  test("draws the largest holding first, so concentration is the first thing seen", () => {
    expect(barsFor(holdings).map((row) => row.name)).toEqual(["Suuri", "Pieni"]);
  });

  test("leaves out a holding that could not be valued rather than drawing it at zero", () => {
    // A bar of no length claims the holding is worth nothing, which is a
    // different and false statement. The table names it with its own reason.
    expect(barsFor(holdings).some((row) => row.name === "Hinnaton")).toBe(false);
  });

  test("a hovered bar says what it is worth and what of that is gain", () => {
    expect(holdingTip({ name: "Suuri", value: 900, gain: 50 })).toContain("+");
    expect(holdingTip({ name: "Tuntematon", value: 900, gain: null })).not.toContain("(");
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
    ).toContain("Ei arvotettavia omistuksia");
  });
});

describe("CategoryTrendChart", () => {
  const months = [
    { month: "2026-01", byCategory: { ruoka: "300.00", ravintolat: "100.00" } },
    { month: "2026-02", byCategory: { ruoka: "350.00", ravintolat: "80.00" } },
  ];
  const categories = [
    { key: "ruoka", label: "Ruoka" },
    { key: "ravintolat", label: "Ravintolat" },
  ];

  test("draws one band per category per month", () => {
    expect(trendRows(months, categories).rows).toHaveLength(4);
  });

  test("folds the ninth category and beyond into one honest group", () => {
    // Past eight, colour stops telling one series from another, and a band
    // nobody can identify is worse than a group that says what it is.
    const many = Array.from({ length: 12 }, (_unused, index) => ({
      key: `k${index}`,
      label: `Erä ${index}`,
    }));
    const { shown } = trendRows(
      [{ month: "2026-01", byCategory: Object.fromEntries(many.map((c) => [c.key, "10.00"])) }],
      many,
    );

    expect(shown).toHaveLength(8);
    expect(shown.at(-1)?.label).toBe("Muu (5)");
  });

  test("sums the folded categories rather than dropping them", () => {
    const many = Array.from({ length: 10 }, (_unused, index) => ({
      key: `k${index}`,
      label: `Erä ${index}`,
    }));
    const { rows } = trendRows(
      [{ month: "2026-01", byCategory: Object.fromEntries(many.map((c) => [c.key, "10.00"])) }],
      many,
    );

    // Three folded categories at 10,00 each: the group carries 30,00, so the
    // stack's top edge is still the month's whole spending.
    expect(rows.find((row) => row.category.startsWith("Muu"))?.amount).toBe(30);
  });

  test("renders", () => {
    expect(() =>
      renders(<CategoryTrendChart months={months} categories={categories} />),
    ).not.toThrow();
  });

  test("says so when there is nothing to show", () => {
    expect(renders(<CategoryTrendChart months={[]} categories={[]} />)).toContain("Ei vielä dataa");
  });
});

describe("axis labels", () => {
  test("a tick reads as a date, never as the milliseconds behind it", () => {
    // The x scale carries epoch milliseconds so elapsed time spaces the points
    // and a span can be narrowed at all -- but nothing a reader sees is ever a
    // millisecond count.
    expect(asDate(Date.UTC(2026, 7, 30))).toBe("30.8.2026");
  });

  test("thousands are compacted, so a five-figure axis stays readable", () => {
    expect(compactEur(50_000)).toBe("50 k€");
    expect(compactEur(0)).toBe("0 €");
  });

  test("a negative tick uses the same minus sign as the tables", () => {
    // The Finnish locale writes a true minus (U+2212); everything else in the
    // app normalises it, and an axis that disagreed with the table under it
    // would look like two different apps.
    expect(compactEur(-12_400)).toBe("-12 k€");
  });
});

describe("a trend over a single month", () => {
  test("says why there is nothing to draw rather than drawing an empty plot", () => {
    // An area needs two points to connect; one month renders as blank axes,
    // which reads as a broken chart rather than as a short period.
    const html = renders(
      <CategoryTrendChart
        months={[{ month: "2026-08", byCategory: { ruoka: "300.00" } }]}
        categories={[{ key: "ruoka", label: "Ruoka" }]}
      />,
    );

    expect(html).toContain("vähintään kaksi kuukautta");
  });
});
