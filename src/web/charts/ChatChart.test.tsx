import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatChartSchema, type ChatChart as Chart } from "../../server/chat/chart-schema.ts";
import { ChatChart } from "./ChatChart.tsx";
import { chatChartRows, colourOf, stackedRows } from "./chat-chart-model.ts";

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
    expect(rows[1]).toContainEqual({ at: 2, x: "2027-01", y: 1200 });
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
