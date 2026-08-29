import { useMemo } from "react";
import { barY, defineChart, group } from "@tanstack/charts";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { Chart } from "@tanstack/react-charts";

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
export const MonthlyFlowChart = ({ months }: { readonly months: readonly MonthlyPoint[] }) => {
  const definition = useMemo(() => {
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
        }),
      ],
      scales: {
        x: { scale: () => scaleBand<string>() },
        y: { scale: scaleLinear, nice: true, grid: true },
      },
    });
  }, [months]);

  if (months.length === 0) return <p className="text-muted">Ei vielä dataa.</p>;

  return (
    <div className="h-72">
      <Chart definition={definition} ariaLabel="Tulot ja menot kuukausittain" />
    </div>
  );
};
