import { useMemo } from "react";
import { areaY, colorLegend, defineChart, stack } from "@tanstack/charts";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scaleOrdinal } from "@tanstack/charts/scales/ordinal";
import { scalePoint } from "@tanstack/charts/scales/point";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/react-charts";

import { eur } from "../lib/format";
import { colourFor, SERIES_COUNT } from "./palette";

export type CategoryMonth = {
  readonly month: string;
  readonly byCategory: Readonly<Record<string, string>>;
};

export type Category = { readonly key: string; readonly label: string };

export type TrendRow = {
  readonly month: string;
  readonly category: string;
  readonly amount: number;
};

/** `2026-03` as `3/26`, short enough that a year of them fits an axis. */
const shortMonth = (month: string): string => {
  const [year = "", number = ""] = month.split("-");
  return `${Number(number)}/${year.slice(2)}`;
};

/**
 * The rows a stacked area needs: one per category per month, zeros included.
 *
 * Categories past the eighth are folded into one "Muu" band rather than given
 * invented hues -- beyond eight, colour stops telling one series from another,
 * and a band nobody can identify is worse than an honest group.
 */
export const trendRows = (months: readonly CategoryMonth[], categories: readonly Category[]) => {
  const kept = categories.slice(0, SERIES_COUNT - 1);
  const rest = categories.slice(SERIES_COUNT - 1);
  const shown =
    rest.length === 0 ? [...kept] : [...kept, { key: "muu", label: `Muu (${rest.length})` }];

  const rows = months.flatMap((month) =>
    shown.map((category) => ({
      month: shortMonth(month.month),
      category: category.label,
      amount:
        category.key === "muu"
          ? rest.reduce((sum, other) => sum + Number(month.byCategory[other.key] ?? "0"), 0)
          : Number(month.byCategory[category.key] ?? "0"),
    })),
  );
  return { rows, shown };
};

/**
 * Spending by category, month by month.
 *
 * The Sankey answers "where did this period's money go"; this answers "is
 * something growing", which no single period can say however well it is drawn.
 * Stacked rather than side by side, because the total matters as much as the
 * parts -- the top edge is the month's whole spending.
 */
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
        ],
        scales: {
          x: { scale: () => scalePoint<string>() },
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
        focus: "group-x",
        tooltip,
      }),
    [rows, shown],
  );

  if (rows.length === 0) return <p className="text-muted">Ei vielä dataa.</p>;

  return (
    <div className="h-72">
      <Chart definition={definition} ariaLabel="Kulutus luokittain kuukausittain" />
    </div>
  );
};
