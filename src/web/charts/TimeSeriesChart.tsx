import { useMemo, useState } from "react";
import { defineChart, lineY } from "@tanstack/charts";
import { crosshair } from "@tanstack/charts/crosshair";
import { brushX, type BrushRange } from "@tanstack/charts/interaction/brush";
import { controlledSignal } from "@tanstack/charts/interaction/signal";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/react-charts";
import { eur, formatDate } from "../lib/format.ts";
import { TIME_FOCUS } from "./interactions.ts";
import { colourFor } from "./palette.ts";

type SeriesPoint = {
  date: string;
  value: number;
  /** Cumulative amount put in by that day; the gap to the value line is the return. */
  invested?: number;
  /** True when a holding had no price and was valued at cost; drawn as its own line so it is never read as market value. */
  estimated?: boolean;
  cash?: number;
};

/** Epoch milliseconds, so elapsed time spaces the points and a range can be narrowed; never shown to a reader. */
const asMillis = (iso: string): number => new Date(`${iso}T00:00:00Z`).getTime();
const isoOf = (millis: number): string => new Date(millis).toISOString().slice(0, 10);
export const asDate = (millis: number): string => formatDate(isoOf(millis));

export const compactEur = (value: number): string =>
  Math.abs(value) >= 1000
    ? `${Math.round(value / 1000).toLocaleString("en-GB")} k€`
    : `${Math.round(value).toLocaleString("en-GB")} €`;

/** `xValue`/`yValue`, never `x`/`y`: those are pixel coordinates. */
export const pointTip = (point: { xValue: unknown; yValue: unknown }): string =>
  `${asDate(Number(point.xValue))}: ${eur(String(point.yValue))}`;

/** Only a committed range counts (previews redraw under the drag); a click commits zero width, which clears. */
export const acceptedRange = (
  next: BrushRange<number>,
  type: "preview" | "commit" | "cancel",
): BrushRange<number> | null | undefined => {
  if (type !== "commit") return undefined;
  return next.end > next.start ? next : null;
};

const RANGES = [
  { label: "1 y", months: 12 },
  { label: "3 y", months: 36 },
  { label: "5 y", months: 60 },
  { label: "All time", months: null },
] as const;

type PlotRow = {
  at: number;
  value: number;
  invested: number | null;
  estimated: boolean;
  cash: number | null;
};

export const plotRows = (points: readonly SeriesPoint[]): PlotRow[] =>
  points.map((point) => ({
    at: asMillis(point.date),
    // Holdings plus cash.
    value: point.value + (point.cash ?? 0),
    invested: point.invested ?? null,
    estimated: point.estimated === true,
    cash: point.cash ?? null,
  }));

/** Value line split into real-price days and valued-at-cost days; the estimate keeps the first real day so the lines meet. */
// ponytail: assumes the estimated days form one run (before the first price),
// which is how missing history looks; a run in the middle would be bridged.
export const splitEstimated = (rows: readonly PlotRow[]) => {
  const real = rows.filter((row) => !row.estimated);
  const lastEstimate = rows.findLastIndex((row) => row.estimated);
  const estimate =
    lastEstimate === -1
      ? []
      : rows
          .slice(0, lastEstimate + 2)
          .filter((row, index) => row.estimated || index === lastEstimate + 1);
  return { real, estimate };
};

/** Preset span: `months` back from the last point (not today), or everything. */
export const presetWindow = (
  rows: readonly PlotRow[],
  months: number | null,
): BrushRange<number> => {
  const first = rows[0]?.at ?? 0;
  const last = rows[rows.length - 1]?.at ?? 0;
  if (months === null) return { start: first, end: last };
  const from = new Date(last);
  from.setUTCMonth(from.getUTCMonth() - months);
  return { start: Math.max(first, from.getTime()), end: last };
};

export const within = (rows: readonly PlotRow[], window: BrushRange<number>): PlotRow[] =>
  rows.filter((row) => row.at >= window.start && row.at <= window.end);

export const TimeSeriesChart = ({ points, label }: { points: SeriesPoint[]; label: string }) => {
  const [months, setMonths] = useState<number | null>(null);
  const [zoom, setZoom] = useState<BrushRange<number> | null>(null);

  const all = useMemo(() => plotRows(points), [points]);
  const window = useMemo(() => zoom ?? presetWindow(all, months), [all, months, zoom]);
  const rows = useMemo(() => within(all, window), [all, window]);
  const split = useMemo(() => splitEstimated(rows), [rows]);

  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          ...(rows.some((row) => row.invested !== null)
            ? [
                lineY(rows, {
                  id: "invested",
                  x: "at",
                  y: "invested",
                  stroke: colourFor(1),
                  strokeWidth: 2,
                  strokeDasharray: "4 3",
                }),
              ]
            : []),
          ...(rows.some((row) => row.cash !== null && row.cash !== 0)
            ? [
                lineY(rows, {
                  id: "cash",
                  x: "at",
                  y: "cash",
                  stroke: colourFor(2),
                  strokeWidth: 2,
                }),
              ]
            : []),
          ...(split.estimate.length > 0
            ? [
                lineY(split.estimate, {
                  id: "estimate",
                  x: "at",
                  y: "value",
                  stroke: "var(--color-muted)",
                  strokeWidth: 2,
                  strokeDasharray: "2 3",
                }),
              ]
            : []),
          lineY(split.real, {
            id: "value",
            x: "at",
            y: "value",
            points: split.real.length <= 60,
            stroke: colourFor(0),
            strokeWidth: 2,
          }),
          crosshair({ x: { label: { format: asDate } }, y: false }),
        ],
        scales: {
          // Pinned to the window so brush and axis describe the same span; a free domain made a second drag impossible.
          x: {
            scale: scaleLinear,
            domain: [window.start, window.end],
            axis: { ticks: { count: 6, format: asDate } },
          },
          y: {
            scale: scaleLinear,
            nice: true,
            grid: true,
            axis: { ticks: { count: 5, format: compactEur } },
          },
        },
        controls: [
          brushX<number>({
            // Zero-width span at the window start: nothing paints until a drag; the committed range is consumed into `zoom`.
            range: controlledSignal({ start: window.start, end: window.start }, (next, context) => {
              const accepted = acceptedRange(next, context.reason.type);
              if (accepted !== undefined) setZoom(accepted);
            }),
            keyboard: false,
            ariaLabel: "Select a time range",
            format: asDate,
            selectionStyle: { fill: "var(--color-accent)", fillOpacity: 0.14, stroke: "none" },
            // Invisible but still a grab target; idle handles would shout for attention.
            handleStyle: { fillOpacity: 0 },
            handleSize: 6,
          }),
        ],
        ...TIME_FOCUS,
        tooltip: { use: tooltip, format: pointTip },
      }),
    // Must not depend on drag state: rebuilding the definition mid-drag destroys the gesture.
    [rows, window, split],
  );

  const show = (next: number | null): void => {
    setMonths(next);
    setZoom(null);
  };

  if (points.length === 0) return <p className="text-muted">No data yet.</p>;

  return (
    <div>
      {/* Above the chart: a control over the plot is unreadable over its line. */}
      <div className="mb-2 flex gap-1 text-xs">
        {RANGES.map((range) => (
          <button
            key={range.label}
            type="button"
            aria-pressed={zoom === null && months === range.months}
            className={`border border-line px-2 py-0.5 ${
              zoom === null && months === range.months ? "bg-line" : ""
            }`}
            onClick={() => show(range.months)}
          >
            {range.label}
          </button>
        ))}
        <span className="self-center text-muted">or drag on the chart</span>
        {rows.some((row) => row.invested !== null) && (
          // Two series, so each line is named rather than identified by colour alone.
          <span className="ml-auto flex items-center gap-3 self-center text-muted">
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4" style={{ background: colourFor(0) }} />
              {rows.some((row) => row.cash !== null && row.cash !== 0)
                ? "Value (incl. cash)"
                : "Value"}
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className="h-0.5 w-4"
                style={{
                  background: `repeating-linear-gradient(90deg, ${colourFor(1)} 0 4px, transparent 4px 7px)`,
                }}
              />
              Invested
            </span>
            {rows.some((row) => row.cash !== null && row.cash !== 0) && (
              <span className="flex items-center gap-1.5">
                <span className="h-0.5 w-4" style={{ background: colourFor(2) }} /> Cash
              </span>
            )}
            {split.estimate.length > 0 && (
              <span
                className="flex items-center gap-1.5"
                title="On days before an instrument's first price, its value is the cost basis, not market value."
              >
                <span
                  className="h-0.5 w-4"
                  style={{
                    background:
                      "repeating-linear-gradient(90deg, var(--color-muted) 0 2px, transparent 2px 5px)",
                  }}
                />
                Valued at cost
              </span>
            )}
          </span>
        )}
      </div>
      <div className="h-72">
        <Chart definition={definition} height={288} ariaLabel={label} />
      </div>
    </div>
  );
};
