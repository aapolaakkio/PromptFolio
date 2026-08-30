import { useMemo } from "react";
import { barY, colorLegend, defineChart, group } from "@tanstack/charts";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleOrdinal } from "@tanstack/charts/scales/ordinal";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/react-charts";
import { eur } from "../lib/format";
import { MARK_FOCUS } from "./interactions";
import { colourFor } from "./palette";

export type MonthlyPoint = { month: string; incomeEur: string; expensesEur: string };

/** `2026-03` as `3/26`, short enough that twelve of them fit an axis. */
const shortMonth = (month: string): string => {
  const [year = "", number = ""] = month.split("-");
  return `${Number(number)}/${year.slice(2)}`;
};

/**
 * Income and spending side by side, one pair of bars per month.
 *
 * Expenses are drawn as a positive height rather than below the axis: the
 * question this answers is "which was bigger", and two bars of comparable
 * height answer it at a glance where a mirrored axis makes the reader do the
 * comparison themselves.
 */
/**
 * Built outside the component so a test can construct it -- `defineChart`
 * validates at run time, and a misplaced scale throws only on mount.
 */
export const monthlyDefinition = (months: readonly MonthlyPoint[]) => {
  const rows = months.flatMap((point) => [
    { month: shortMonth(point.month), kind: "Tulot", amount: Number(point.incomeEur) },
    { month: shortMonth(point.month), kind: "Menot", amount: Number(point.expensesEur) },
  ]);

  return defineChart({
    marks: [
      barY(rows, {
        x: "month",
        y: "amount",
        color: "kind",
        layout: group(),
        // Rounded at the data end only: the bar stays anchored to the
        // baseline, which is what its length is measured from.
        radius: 4,
        // A gap of surface between the paired bars, so two adjacent fills
        // read as two bars rather than one wide one.
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
    // A sibling of `scales`, not one of them -- the positional scale ids are
    // reserved, and a colour scale among them fails at runtime.
    color: {
      scale: scaleOrdinal<string, string>()
        .domain(["Tulot", "Menot"])
        .range([colourFor(2), colourFor(1)]),
      // Two series, so a legend is not optional: identity must never rest on
      // colour alone.
      legend: colorLegend({ label: "" }),
    },
    ...MARK_FOCUS,
    tooltip,
  });
};

export const MonthlyFlowChart = ({ months }: { readonly months: readonly MonthlyPoint[] }) => {
  const definition = useMemo(() => monthlyDefinition(months), [months]);

  if (months.length === 0) return <p className="text-muted">Ei vielä dataa.</p>;

  return (
    <div className="h-72">
      <Chart definition={definition} ariaLabel="Tulot ja menot kuukausittain" />
    </div>
  );
};
