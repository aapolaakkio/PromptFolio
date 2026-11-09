import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { ChatChart as Chart } from "../../server/chat/chart-schema.ts";
import { ChatChart, chatChartRows } from "./ChatChart.tsx";

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
    series: [
      {
        label: "S1 expected",
        points: [
          { x: "2026-11", y: 1000 },
          { x: "2026-12", y: 1010 },
        ],
      },
      {
        label: "S1 expected",
        points: [
          { x: "2026-11", y: 1000 },
          { x: "2027-01", y: 1200 },
        ],
      },
    ],
  },
});

describe("chatChartRows", () => {
  test("puts every series on one sorted x axis and keeps labels unique", () => {
    const { xs, labels, rows } = chatChartRows(chart("line").data);
    expect(xs).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(labels).toEqual(["S1 expected", "S1 expected (2)"]);
    expect(rows).toContainEqual({ at: 2, x: "2027-01", series: "S1 expected (2)", y: 1200 });
  });

  test("keeps the app's order for category labels", () => {
    const { xs } = chatChartRows({
      series: [
        {
          label: "Allocation",
          points: [
            { x: "Shares", y: 60 },
            { x: "Funds", y: 40 },
          ],
        },
      ],
    });
    expect(xs).toEqual(["Shares", "Funds"]);
  });
});

describe("ChatChart", () => {
  test.each(["line", "area", "bar", "stacked-bar"] as const)("renders a %s chart", (kind) => {
    expect(() => renderToStaticMarkup(<ChatChart chart={chart(kind)} />)).not.toThrow();
  });

  test("shows the title and the labelled note as plain text", () => {
    const html = renderToStaticMarkup(<ChatChart chart={chart("line", "<i>Rough</i>")} />);
    expect(html).toContain("&lt;b&gt;Two scenarios&lt;/b&gt;");
    expect(html).toContain("Assistant&#x27;s note");
    expect(html).toContain("&lt;i&gt;Rough&lt;/i&gt;");
  });
});
