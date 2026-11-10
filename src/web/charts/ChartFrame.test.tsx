import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { AllocationChart } from "./AllocationChart.tsx";
import { CashFlowChart } from "./CashFlowChart.tsx";
import { CategoryTrendChart } from "./CategoryTrendChart.tsx";
import { ChartFrame } from "./ChartFrame.tsx";
import { ChatChart } from "./ChatChart.tsx";
import { ForecastChart } from "./ForecastChart.tsx";
import { HoldingsChart } from "./HoldingsChart.tsx";
import { MonthlyFlowChart } from "./MonthlyFlowChart.tsx";
import { TimeSeriesChart } from "./TimeSeriesChart.tsx";

const FRAME = "data-chart-frame";

const band = (expected: number) => ({ low: expected - 10, expected, high: expected + 10 });
const months = [
  { month: "2026-01", incomeEur: "3000.00", expensesEur: "2000.00" },
  { month: "2026-02", incomeEur: "3000.00", expensesEur: "2500.00" },
];

const charts = {
  AllocationChart: (
    <AllocationChart slices={[{ key: "s", label: "Shares", valueEur: "10.00", weight: 1 }]} />
  ),
  CashFlowChart: (
    <CashFlowChart
      nodes={[
        { id: "income", label: "Income", totalEur: "100.00" },
        { id: "out:food", label: "Food", totalEur: "100.00" },
      ]}
      links={[{ from: "income", to: "out:food", amountEur: "100.00" }]}
    />
  ),
  CategoryTrendChart: (
    <CategoryTrendChart
      months={[
        { month: "2026-01", byCategory: { food: "300.00" } },
        { month: "2026-02", byCategory: { food: "350.00" } },
      ]}
      categories={[{ key: "food", label: "Food" }]}
    />
  ),
  ChatChart: (
    <ChatChart
      chart={{
        chartId: "c1",
        spec: {
          title: "Two scenarios",
          kind: "line",
          yUnit: "EUR",
          series: [{ source: "forecast", scenarioId: "S1", path: "expected" }],
        },
        data: {
          series: [
            {
              label: "S1 expected",
              unit: "EUR",
              points: [
                { x: "2026-11", y: 1000 },
                { x: "2026-12", y: 1010 },
              ],
            },
          ],
          yScale: "linear",
          notes: [],
        },
      }}
    />
  ),
  ForecastChart: (
    <ForecastChart
      points={[0, 1].map((index) => ({
        index,
        month: `2027-0${index + 1}`,
        total: band(1000 + index),
        holdings: [],
        newMoneyEur: 0,
      }))}
    />
  ),
  HoldingsChart: (
    <HoldingsChart
      holdings={[{ instrumentId: 1, name: "A", valueEur: "100.00", unrealisedEur: "1.00" }]}
    />
  ),
  MonthlyFlowChart: <MonthlyFlowChart months={months} />,
  TimeSeriesChart: (
    <TimeSeriesChart
      label="Value"
      points={[
        { date: "2026-01-01", value: 1000, invested: 900 },
        { date: "2026-02-01", value: 1100, invested: 950 },
      ]}
    />
  ),
} satisfies Record<string, React.ReactElement>;

describe("ChartFrame", () => {
  test("offers PNG and PDF from a real button that says it opens a menu", () => {
    const html = renderToStaticMarkup(
      <ChartFrame title="Allocation">
        <p>chart</p>
      </ChartFrame>,
    );

    expect(html).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/);
    expect(html).toContain("Export");
    // Closed until asked for.
    expect(html).not.toContain('role="menu"');
  });

  test("keeps its own menu out of what is exported", () => {
    const html = renderToStaticMarkup(
      <ChartFrame title="Allocation">
        <p>chart</p>
      </ChartFrame>,
    );

    expect(html).toMatch(/<div[^>]*data-no-export[^>]*>\s*<button/);
  });
});

describe("every chart", () => {
  test("has a case here, so a new chart file cannot be forgotten", () => {
    const files = readdirSync(import.meta.dirname)
      .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
      .filter((name) =>
        readFileSync(`${import.meta.dirname}/${name}`, "utf8").includes("@tanstack/react-charts"),
      )
      .map((name) => name.replace(".tsx", ""));

    expect(files.toSorted()).toEqual(Object.keys(charts).toSorted());
  });

  test.each(Object.entries(charts))("%s renders inside the export frame", (_name, element) => {
    const html = renderToStaticMarkup(element);

    expect(html).toContain(FRAME);
    expect(html.indexOf(FRAME)).toBeLessThan(html.indexOf("<svg"));
    expect(html).toContain("Export");
  });

  test("with no data shows no Export menu", () => {
    const empty = [
      <AllocationChart key="a" slices={[]} />,
      <CashFlowChart key="c" nodes={[]} links={[]} />,
      <CategoryTrendChart key="t" months={[]} categories={[]} />,
      <ForecastChart key="f" points={[]} />,
      <HoldingsChart key="h" holdings={[]} />,
      <MonthlyFlowChart key="m" months={[]} />,
      <TimeSeriesChart key="s" points={[]} label="Value" />,
    ];

    for (const element of empty) {
      const html = renderToStaticMarkup(element);
      expect(html).not.toContain(FRAME);
      expect(html).not.toContain("Export");
    }
  });
});

describe("legends", () => {
  test.each([
    ["AllocationChart", charts.AllocationChart],
    ["ChatChart", charts.ChatChart],
    ["ForecastChart", charts.ForecastChart],
    ["TimeSeriesChart", charts.TimeSeriesChart],
  ])("%s marks its HTML legend entries for the PNG", (_name, element) => {
    expect(renderToStaticMarkup(element)).toContain("data-legend-item");
  });
});
