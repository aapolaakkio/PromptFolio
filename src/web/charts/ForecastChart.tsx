import { useMemo } from "react";
import { areaY, defineChart, lineY } from "@tanstack/charts";
import { crosshair } from "@tanstack/charts/crosshair";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/react-charts";

import type { ForecastPoint } from "../../core/forecast.ts";
import { eur } from "../lib/format.ts";
import { ChartFrame } from "./ChartFrame.tsx";
import { TIME_FOCUS } from "./interactions.ts";
import { colourFor } from "./palette.ts";
import { compactEur } from "./TimeSeriesChart.tsx";

/** "2031-04" as 04/2031. */
const monthText = (month: string): string => `${month.slice(5)}/${month.slice(0, 4)}`;

/** Total expected value with its 10–90 % band, by month index from today. */
export const ForecastChart = ({ points }: { readonly points: readonly ForecastPoint[] }) => {
  const rows = useMemo(
    () =>
      points.map((point) => ({
        at: point.index,
        month: point.month,
        low: point.total.low,
        expected: point.total.expected,
        high: point.total.high,
      })),
    [points],
  );
  const definition = useMemo(() => {
    const labelAt = (index: number): string => {
      const row = rows[Math.round(index)];
      return row === undefined ? "" : monthText(row.month);
    };
    return defineChart({
      marks: [
        areaY(rows, {
          id: "band",
          x: "at",
          y1: "low",
          y2: "high",
          fill: colourFor(0),
          fillOpacity: 0.16,
        }),
        lineY(rows, {
          id: "expected",
          x: "at",
          y: "expected",
          stroke: colourFor(0),
          strokeWidth: 2,
        }),
        crosshair({ x: { label: { format: labelAt } }, y: false }),
      ],
      scales: {
        x: {
          scale: scaleLinear,
          domain: [0, Math.max(1, rows.length - 1)],
          axis: { ticks: { count: 6, format: labelAt } },
        },
        y: {
          scale: scaleLinear,
          nice: true,
          grid: true,
          axis: { ticks: { count: 5, format: compactEur } },
        },
      },
      ...TIME_FOCUS,
      tooltip: {
        use: tooltip,
        format: (point: { xValue: unknown; yValue: unknown }) =>
          `${labelAt(Number(point.xValue))}: ${eur(String(point.yValue))}`,
      },
    });
  }, [rows]);

  if (points.length === 0) return <p className="text-muted">No data yet.</p>;

  return (
    <ChartFrame title="Forecast of the portfolio value">
      <div className="mb-2 flex items-center gap-3 text-xs text-muted">
        <span data-legend-item="" className="flex items-center gap-1.5">
          <span className="h-0.5 w-4" style={{ background: colourFor(0) }} /> Expected
        </span>
        <span data-legend-item="" className="flex items-center gap-1.5">
          <span className="h-2 w-4 opacity-30" style={{ background: colourFor(0) }} />
          Rough range (10–90 %)
        </span>
      </div>
      <div className="h-72">
        <Chart definition={definition} height={288} ariaLabel="Forecast of the portfolio value" />
      </div>
    </ChartFrame>
  );
};
