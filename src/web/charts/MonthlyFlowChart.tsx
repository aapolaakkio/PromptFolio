import { useMemo } from "react";
import { barY, colorLegend, defineChart, group } from "@tanstack/charts";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleOrdinal } from "@tanstack/charts/scales/ordinal";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/react-charts";
import { eur } from "../lib/format.ts";
import { shortMonth } from "./CategoryTrendChart.tsx";
import { MARK_FOCUS } from "./interactions.ts";
import { colourFor } from "./palette.ts";

type MonthlyPoint = { month: string; incomeEur: string; expensesEur: string };

/** Income and spending as paired bars per month; expenses are drawn upward so "which was bigger" reads at a glance. */
/** Exported so a test can build it: a misplaced scale throws only on mount. */
const monthlyDefinition = (months: readonly MonthlyPoint[]) => {
  const rows = months.flatMap((point) => [
    { month: shortMonth(point.month), kind: "Income", amount: Number(point.incomeEur) },
    { month: shortMonth(point.month), kind: "Spending", amount: Number(point.expensesEur) },
  ]);

  return defineChart({
    marks: [
      barY(rows, {
        x: "month",
        y: "amount",
        color: "kind",
        layout: group(),
        // Rounded at the data end only: the bar stays anchored to its baseline.
        radius: 4,
        // A surface gap so paired bars read as two.
        inset: 1,
      }),
    ],
    scales: {
      x: { scale: () => scaleBand<string>() },
      y: {
        scale: scaleLinear,
        nice: true,
        grid: true,
        axis: { ticks: { format: (value: number) => eur(String(value)) } },
      },
    },
    // Sibling of `scales`: positional scale ids are reserved.
    color: {
      scale: scaleOrdinal<string, string>()
        .domain(["Income", "Spending"])
        .range([colourFor(2), colourFor(1)]),
      // Two series: identity must not rest on colour alone.
      legend: colorLegend({ label: "" }),
    },
    ...MARK_FOCUS,
    tooltip,
  });
};

export const MonthlyFlowChart = ({ months }: { readonly months: readonly MonthlyPoint[] }) => {
  const definition = useMemo(() => monthlyDefinition(months), [months]);

  if (months.length === 0) return <p className="text-muted">No data yet.</p>;

  return (
    <div className="h-72">
      <Chart definition={definition} height={288} ariaLabel="Income and spending by month" />
    </div>
  );
};
