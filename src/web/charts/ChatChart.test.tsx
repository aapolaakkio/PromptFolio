import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatChartSchema, type ChatChart as Chart } from "../../server/chat/chart-schema.ts";
import { ChatChart } from "./ChatChart.tsx";
import { chatChartRows, colourOf, stackedRows } from "./chat-chart-model.ts";
import { annotationMarks, extentOf, layoutFor, plotsFor } from "./chat-chart-marks.ts";

const months = ["2026-11", "2026-12", "2027-01"];
const series = (label: string, ys: readonly number[], unit: "EUR" | "%" = "EUR") => ({
  label,
  unit,
  points: ys.map((y, index) => ({ x: months[index] ?? "2027-02", y })),
});

const chart = (kind: Chart["spec"]["kind"], note?: string): Chart => ({
  chartId: "c1",
  spec: {
    title: "<b>Two scenarios</b>",
    kind,
    yUnit: "EUR",
    series: [
      { source: "forecast", scenarioId: "S1", path: "expected" },
      { source: "forecast", scenarioId: "S2", path: "expected" },
    ],
    note,
  },
  data: {
    series: [series("S1 expected", [1000, 1010]), series("S1 expected", [1000, 1100, 1200])],
    yScale: "linear",
    notes: [],
  },
});

/** Every styling field at once: mixed kinds, both axes, a band, a stack and all three annotations. */
const styled: Chart = {
  chartId: "c2",
  spec: {
    title: "Plan versus value",
    subtitle: "Ten years, today's euros",
    kind: "line",
    yUnit: "EUR",
    yScale: "log",
    yMin: 500,
    yMax: 5000,
    yFormat: "compact-EUR",
    xLabel: "Month",
    yLabel: "Value",
    grid: false,
    legend: "bottom",
    height: 420,
    band: { scenarioId: "S1", label: "Rough range", color: 2, fillOpacity: 0.2 },
    annotations: [
      { type: "y-line", y: 2000, label: "Goal", color: "#e34948" },
      { type: "x-line", x: "2026-12", label: "Bonus" },
      { type: "x-range", from: "2026-12", to: "2027-01", label: "Crash", color: 8 },
    ],
    series: [
      {
        source: "forecast",
        scenarioId: "S1",
        path: "expected",
        kind: "line",
        label: "Expected",
        color: "#2a78d6",
        width: 3,
        dash: "dashed",
        opacity: 0.9,
        curve: "smooth",
        points: true,
      },
      { source: "forecast", scenarioId: "S1", path: "low", kind: "step", dash: "dotted" },
      { source: "forecast", scenarioId: "S1", path: "high", kind: "scatter", color: 4 },
      {
        source: "forecast",
        scenarioId: "S1",
        path: "high",
        kind: "area",
        fillOpacity: 0.4,
        curve: "step",
      },
      {
        source: "forecast",
        scenarioId: "S1",
        path: "contributed",
        kind: "bar",
        axis: "right",
        stack: "money",
        transform: "cumulative",
      },
      {
        source: "allocation",
        dimension: "kind",
        kind: "bar",
        axis: "right",
        stack: "money",
        transform: "none",
      },
    ],
    note: "Rough.",
  },
  data: {
    series: [
      series("S1 expected", [1000, 1500, 2000]),
      series("S1 low", [900, 1200, 1500]),
      series("S1 high", [1100, 1800, 2600]),
      series("S1 high", [1100, 1800, 2600]),
      series("S1 money put in", [0, 100, 200]),
      series("Other", [0, 50, 50]),
    ],
    band: {
      label: "S1 range",
      points: months.map((x, index) => ({ x, low: 900 + index, high: 1100 + index })),
    },
    yScale: "log",
    notes: [],
  },
};

describe("chatChartRows", () => {
  test("puts every series on one sorted x axis and keeps labels unique", () => {
    const { xs, labels, rows } = chatChartRows(chart("line").data);
    expect(xs).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(labels).toEqual(["S1 expected", "S1 expected (2)"]);
    expect(rows[1]).toContainEqual({
      at: Date.UTC(2027, 0, 1),
      x: "2027-01",
      y: 1200,
      estimated: false,
    });
  });

  test("keeps the app's order for category labels", () => {
    const { xs } = chatChartRows({
      series: [
        {
          label: "Allocation",
          unit: "%",
          points: [
            { x: "Shares", y: 60 },
            { x: "Funds", y: 40 },
          ],
        },
      ],
      yScale: "linear",
      notes: [],
    });
    expect(xs).toEqual(["Shares", "Funds"]);
  });
});

describe("stackedRows", () => {
  test("series with one stack id sit on each other; others start at zero", () => {
    const stacks = stackedRows(
      [
        [
          { at: 0, y: 1 },
          { at: 1, y: 2 },
        ],
        [{ at: 0, y: 10 }],
        [{ at: 0, y: 5 }],
      ],
      ["a", "a", undefined],
    );
    expect(stacks).toEqual([
      [
        { at: 0, y1: 0, y2: 1 },
        { at: 1, y1: 0, y2: 2 },
      ],
      [{ at: 0, y1: 1, y2: 11 }],
      [{ at: 0, y1: 0, y2: 5 }],
    ]);
  });
});

describe("colourOf", () => {
  test("a palette slot or a hex passes; anything else falls back to the series slot", () => {
    expect(colourOf(3, 0)).toBe("var(--series-3)");
    expect(colourOf("#abc", 0)).toBe("#abc");
    expect(colourOf(undefined, 1)).toBe("var(--series-2)");
  });
});

describe("ChatChart", () => {
  test.each(["line", "area", "bar", "stacked-bar"] as const)("renders a %s chart", (kind) => {
    expect(() => renderToStaticMarkup(<ChatChart chart={chart(kind)} />)).not.toThrow();
  });

  test("a spec using every styling field validates and renders", () => {
    expect(ChatChartSchema.parse(styled)).toEqual(styled);
    const html = renderToStaticMarkup(<ChatChart chart={styled} />);
    expect(html).toContain("Ten years, today&#x27;s euros");
    expect(html).toContain("Expected");
    expect(html).toContain("Goal");
    expect(html).toContain("Crash");
    expect(html).toContain("#2a78d6");
  });

  test("shows the title, the labelled note and the app's notes as plain text", () => {
    const html = renderToStaticMarkup(
      <ChatChart
        chart={{
          ...chart("line", "<i>Rough</i>"),
          data: { ...chart("line").data, notes: ["The log scale needs values above zero."] },
        }}
      />,
    );
    expect(html).toContain("&lt;b&gt;Two scenarios&lt;/b&gt;");
    expect(html).toContain("Assistant&#x27;s note");
    expect(html).toContain("&lt;i&gt;Rough&lt;/i&gt;");
    expect(html).toContain("The log scale needs values above zero.");
  });

  test("no legend when asked for none", () => {
    const html = renderToStaticMarkup(
      <ChatChart chart={{ ...chart("line"), spec: { ...chart("line").spec, legend: "none" } }} />,
    );
    expect(html).not.toContain('aria-label="Legend"');
  });
});

const days = (from: string, count: number) =>
  Array.from({ length: count }, (_unused, index) => ({
    x: new Date(Date.parse(`${from}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10),
    y: 1000 + index,
  }));

describe("time axis", () => {
  test("a year of days beside ten years of months takes about an eleventh of the width", () => {
    const value = {
      label: "Portfolio value",
      unit: "EUR" as const,
      points: days("2025-11-09", 366),
    };
    const months = Array.from({ length: 121 }, (_unused, index) => {
      const at = new Date(Date.UTC(2026, 10 + index, 1));
      return { x: at.toISOString().slice(0, 7), y: 2000 + index };
    });
    const rows = chatChartRows({
      series: [value, { label: "S1 expected", unit: "EUR", points: months }],
      yScale: "linear",
      notes: [],
    });
    const join = rows.atOf("2026-11");
    expect((join - rows.first) / (rows.last - rows.first)).toBeCloseTo(1 / 11, 1);
  });
});

const logBars: Chart = {
  chartId: "log",
  spec: {
    title: "Log bars",
    kind: "bar",
    yUnit: "EUR",
    yScale: "log",
    series: [{ source: "spending-by-month", months: 3 }],
    annotations: [{ type: "y-line", y: 5000, label: "Line", axis: "right" }],
  },
  data: { series: [series("All spending", [100, 1000, 10000])], yScale: "log", notes: [] },
};

describe("log axis", () => {
  test("bars start from a floor, so every plotted value and the domain are finite", () => {
    const layout = layoutFor(logBars);
    const plots = plotsFor(layout, 0);
    expect(plots.every((row) => Number.isFinite(row.y1) && Number.isFinite(row.y2))).toBe(true);
    expect(plots[0]?.y1).toBeCloseTo(Math.log10(50));
    const extent = extentOf(layout, []);
    expect([extent.top, extent.bottom].every(Number.isFinite)).toBe(true);
    expect(() => renderToStaticMarkup(<ChatChart chart={logBars} />)).not.toThrow();
  });

  test("a right-axis line with no right series goes on the left scale, in log terms", () => {
    const layout = layoutFor(logBars);
    const marks = annotationMarks(layout, extentOf(layout, []));
    expect(marks).toHaveLength(2);
    expect(layout.onLeft(5000)).toBeCloseTo(Math.log10(5000));
  });
});

describe("labels", () => {
  const relabelled: Chart = {
    ...chart("line"),
    spec: {
      ...chart("line").spec,
      legend: "top",
      series: [
        { source: "forecast", scenarioId: "S1", path: "low", label: "Expected" },
        { source: "forecast", scenarioId: "S2", path: "expected" },
      ],
    },
    data: {
      series: [series("S1 low (10 %)", [900, 950]), series("S2 expected", [1000, 1100])],
      yScale: "linear",
      notes: [],
    },
  };

  test("the legend shows the app's label after the model's when they differ", () => {
    const html = renderToStaticMarkup(<ChatChart chart={relabelled} />);
    expect(html).toContain("Expected");
    expect(html).toContain("(S1 low (10 %))");
  });

  test("the tooltip always names the app's label, even with no legend", () => {
    const hidden = { ...relabelled, spec: { ...relabelled.spec, legend: "none" as const } };
    const plots = plotsFor(layoutFor(hidden), 0);
    expect(plots[0]?.tip.startsWith("S1 low (10 %)")).toBe(true);
  });

  test("annotation labels are listed in italics with a note mark", () => {
    const html = renderToStaticMarkup(<ChatChart chart={logBars} />);
    expect(html).toContain('aria-label="Chart notes"');
    expect(html).toContain("✎ Line");
  });
});

describe("estimated days", () => {
  test("are drawn as a dashed overlay and named in the tooltip", () => {
    const flagged: Chart = {
      ...chart("line"),
      data: {
        series: [
          {
            label: "Portfolio value",
            unit: "EUR",
            points: [
              { x: "2026-11-01", y: 1000, estimated: true },
              { x: "2026-11-02", y: 1010 },
            ],
          },
        ],
        yScale: "linear",
        notes: [],
      },
    };
    const plots = plotsFor(layoutFor(flagged), 0);
    expect(plots.map((row) => row.ey)).toEqual([1000, null]);
    expect(plots[0]?.tip).toContain("(estimated)");
    expect(() => renderToStaticMarkup(<ChatChart chart={flagged} />)).not.toThrow();
  });
});
