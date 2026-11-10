import { useMemo } from "react";
import { areaY, colorLegend, defineChart, stack } from "@tanstack/charts";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scaleOrdinal } from "@tanstack/charts/scales/ordinal";
import { scalePoint } from "@tanstack/charts/scales/point";
import { tooltip } from "@tanstack/charts/tooltip";
import { crosshair } from "@tanstack/charts/crosshair";
import { Chart } from "@tanstack/react-charts";

import type { CategoryMonth } from "../../server/spending/monthly.ts";
import { eur } from "../lib/format.ts";
import { ChartFrame } from "./ChartFrame.tsx";
import { GROUP_FOCUS } from "./interactions.ts";
import { colourFor, SERIES_COUNT } from "./palette.ts";

export type Category = { readonly key: string; readonly label: string };

/** `2026-03` as `3/26`, for tick labels only: keying rows by it could collide two months. */
export const shortMonth = (month: string): string => {
  const [year = "", number = ""] = month.split("-");
  return `${Number(number)}/${year.slice(2)}`;
};

/** Stacked-area rows: one per category per month, zeros included; categories past the eighth fold into "Other". */
export const trendRows = (months: readonly CategoryMonth[], categories: readonly Category[]) => {
  const kept = categories.slice(0, SERIES_COUNT - 1);
  const rest = categories.slice(SERIES_COUNT - 1);
  const shown =
    rest.length === 0 ? [...kept] : [...kept, { key: "other", label: `Other (${rest.length})` }];

  const rows = months.flatMap((month) =>
    shown.map((category) => ({
      // The ISO month, not its label: a display string is not an identity.
      month: month.month,
      category: category.label,
      amount:
        category.key === "other"
          ? rest.reduce((sum, other) => sum + Number(month.byCategory[other.key] ?? "0"), 0)
          : Number(month.byCategory[category.key] ?? "0"),
    })),
  );
  return { rows, shown };
};

/** Spending by category per month, stacked so the top edge is the month total; answers "is something growing". */
export const CategoryTrendChart = ({
  months,
  categories,
}: {
  readonly months: readonly CategoryMonth[];
  readonly categories: readonly Category[];
}) => {
  const { rows, shown } = useMemo(() => trendRows(months, categories), [months, categories]);

  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          areaY(rows, {
            x: "month",
            y: "amount",
            color: "category",
            layout: stack(),
            fillOpacity: 0.85,
          }),
          crosshair({ y: false }),
        ],
        scales: {
          x: {
            scale: () => scalePoint<string>(),
            axis: { ticks: { format: shortMonth } },
          },
          y: {
            scale: scaleLinear,
            nice: true,
            grid: true,
            axis: { ticks: { count: 4, format: (value: number) => eur(String(value)) } },
          },
        },
        color: {
          scale: scaleOrdinal<string, string>()
            .domain(shown.map((category) => category.label))
            .range(shown.map((_category, index) => colourFor(index))),
          legend: colorLegend({ label: "" }),
        },
        ...GROUP_FOCUS,
        tooltip,
      }),
    [rows, shown],
  );

  if (rows.length === 0) return <p className="text-muted">No data yet.</p>;
  if (months.length < 2) {
    // One month is nothing to connect; say so rather than draw an empty plot.
    return (
      <p className="text-muted">The trend appears once the period spans at least two months.</p>
    );
  }

  return (
    <ChartFrame title="Spending by category by month">
      <div className="h-72">
        <Chart definition={definition} height={288} ariaLabel="Spending by category by month" />
      </div>
    </ChartFrame>
  );
};
