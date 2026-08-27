import { useMemo } from "react";
import { defineChart, lineY } from "@tanstack/charts";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scalePoint } from "@tanstack/charts/scales/point";
import { Chart } from "@tanstack/react-charts";
import { fiDate } from "../lib/format";
import { colourFor } from "./palette";

export type SeriesPoint = { date: string; value: number };

/**
 * `@tanstack/react-charts@0.16` turned out to be nothing like the brief's
 * sketch (`<Chart options={{ data, primaryAxis, secondaryAxes }} />`, a
 * flat per-series config object). The published 0.16 API is a
 * grammar-of-graphics rewrite: `defineChart({ marks, scales })` from
 * `@tanstack/charts` builds a definition, and `@tanstack/react-charts`'s
 * `<Chart definition={...} ariaLabel={...} />` only mounts it -- it has no
 * `options` prop at all. This file (and AllocationChart.tsx) is the whole
 * blast radius, per the brief; adapting here rather than replacing it with
 * inline SVG because the real API, once found, maps directly onto a single
 * `lineY` mark.
 *
 * `date` is treated as a point-scale category rather than upgraded to a
 * genuine D3 time scale: `core/returns.ts`'s `valueSeries` always emits one
 * point per *calendar day* with no gaps (see `datesBetween`), so point
 * spacing and elapsed-time spacing coincide exactly here, and pulling in
 * `d3-scale` just for `scaleUtc` would add a dependency for a mapping this
 * data doesn't need.
 */
export const TimeSeriesChart = ({ points, label }: { points: SeriesPoint[]; label: string }) => {
  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          lineY(points, {
            id: "value",
            x: "date",
            y: "value",
            points: points.length <= 60,
            stroke: colourFor(0),
          }),
        ],
        scales: {
          x: {
            scale: () => scalePoint<string>(),
            axis: {
              ticks: { count: 6, format: (value: string) => fiDate(value) },
            },
          },
          y: {
            scale: scaleLinear,
            nice: true,
            grid: true,
          },
        },
      }),
    [points],
  );

  if (points.length === 0) return <p className="text-muted">Ei vielä dataa.</p>;

  return (
    <div className="h-80">
      <Chart definition={definition} ariaLabel={label} aspectRatio={16 / 6} initialWidth={640} />
    </div>
  );
};
