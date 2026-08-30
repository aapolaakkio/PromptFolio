import { useMemo, useState } from "react";
import { defineChart, lineY } from "@tanstack/charts";
import { crosshair } from "@tanstack/charts/crosshair";
import { brushX, type BrushRange } from "@tanstack/charts/interaction/brush";
import { controlledSignal } from "@tanstack/charts/interaction/signal";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/react-charts";
import { eur, fiDate } from "../lib/format.ts";
import { TIME_FOCUS } from "./interactions.ts";
import { colourFor } from "./palette.ts";

export type SeriesPoint = {
  date: string;
  value: number;
  /**
   * What had been put into holdings by that day, when the caller has it. Drawn
   * as a second line: the gap between the two is the return, and it is the one
   * picture that makes a percentage feel like money -- a rising value line
   * above a flat invested line is growth, the same line above an equally
   * rising one is only deposits.
   */
  invested?: number;
};

/**
 * The x axis carries epoch milliseconds, but nothing a reader sees is ever one:
 * every tick, label and tooltip formats back to a Finnish date. The numbers exist
 * so elapsed time spaces the points, and because a categorical axis cannot be
 * narrowed to a range at all.
 */
const asMillis = (iso: string): number => new Date(`${iso}T00:00:00Z`).getTime();
const isoOf = (millis: number): string => new Date(millis).toISOString().slice(0, 10);
export const asDate = (millis: number): string => fiDate(isoOf(millis));

/** Thousands as "12 k€", so a y axis of five-figure sums stays readable. */
export const compactEur = (value: number): string => {
  const rounded =
    Math.abs(value) >= 1000
      ? `${Math.round(value / 1000).toLocaleString("fi-FI")} k€`
      : `${Math.round(value).toLocaleString("fi-FI")} €`;
  // The Finnish locale writes a true minus (U+2212). Everything else in this
  // app normalises it to the ASCII one (`format.ts`), and an axis that
  // disagreed with the table under it would look like two different apps.
  return rounded.replace(/−/g, "-");
};

/**
 * What a hovered point says. `xValue`/`yValue`, never `x`/`y`: those are pixel
 * coordinates, and reading them printed a position on screen as a date and a
 * euro amount -- plausible numbers wrong in both.
 */
export const pointTip = (point: { xValue: unknown; yValue: unknown }): string =>
  `${asDate(Number(point.xValue))}: ${eur(String(point.yValue))}`;

/**
 * What a brush change means, or undefined to ignore it. Only a committed range
 * counts: accepting previews redrew the chart under the drag, so a selection
 * could never settle. A click commits a zero-width range, which clears.
 */
export const acceptedRange = (
  next: BrushRange<number>,
  type: "preview" | "commit" | "cancel",
): BrushRange<number> | null | undefined => {
  if (type !== "commit") return undefined;
  return next.end > next.start ? next : null;
};

/** The ranges worth offering, as months back from the last point. */
const RANGES = [
  { label: "1 v", months: 12 },
  { label: "3 v", months: 36 },
  { label: "5 v", months: 60 },
  { label: "Koko jakso", months: null },
] as const;

export type PlotRow = { at: number; value: number; invested: number | null };

/** Every point, as the chart plots them. */
export const plotRows = (points: readonly SeriesPoint[]): PlotRow[] =>
  points.map((point) => ({
    at: asMillis(point.date),
    value: point.value,
    invested: point.invested ?? null,
  }));

/**
 * The span a preset button selects: `months` back from the most recent point,
 * or everything.
 *
 * Measured from the last point rather than from today, so a ledger whose last
 * price is a month old still shows something for "1 v".
 */
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

/** The rows inside a window, endpoints included. */
export const within = (rows: readonly PlotRow[], window: BrushRange<number>): PlotRow[] =>
  rows.filter((row) => row.at >= window.start && row.at <= window.end);

export const TimeSeriesChart = ({ points, label }: { points: SeriesPoint[]; label: string }) => {
  const [months, setMonths] = useState<number | null>(null);
  /** A span dragged on the chart itself, which overrides whichever preset is lit. */
  const [zoom, setZoom] = useState<BrushRange<number> | null>(null);

  const all = useMemo(() => plotRows(points), [points]);
  const window = useMemo(() => zoom ?? presetWindow(all, months), [all, months, zoom]);
  const rows = useMemo(() => within(all, window), [all, window]);

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
          lineY(rows, {
            id: "value",
            x: "at",
            y: "value",
            points: rows.length <= 60,
            stroke: colourFor(0),
            strokeWidth: 2,
          }),
          crosshair({ x: { label: { format: asDate } }, y: false }),
        ],
        scales: {
          // Pinned to the window rather than left to the data, so the brush and
          // the axis always describe the same span. With the domain free, a
          // second drag inside an already-narrowed chart mapped the pointer
          // against one range while the axis showed another, and selecting
          // anything became impossible.
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
            // Always a zero-width span at the window's start, so nothing is
            // painted until a drag begins and nothing lingers after one ends.
            // The committed range is consumed into `zoom` immediately, and the
            // narrowed chart is what says which span was chosen.
            range: controlledSignal({ start: window.start, end: window.start }, (next, context) => {
              const accepted = acceptedRange(next, context.reason.type);
              if (accepted !== undefined) setZoom(accepted);
            }),
            keyboard: false,
            ariaLabel: "Valitse aikaväli",
            format: asDate,
            selectionStyle: { fill: "var(--color-accent)", fillOpacity: 0.14, stroke: "none" },
            // Invisible, but still a real grab target: the selection rectangle
            // is the feedback a drag needs, and two handles parked on an idle
            // plot are a control shouting for attention while doing nothing.
            handleStyle: { fillOpacity: 0 },
            handleSize: 6,
          }),
        ],
        ...TIME_FOCUS,
        tooltip: { use: tooltip, format: pointTip },
      }),
    // Deliberately not dependent on any drag-in-progress state: rebuilding the
    // definition mid-drag destroys the gesture, which is why the first drag
    // used to do nothing and only the second appeared to work.
    [rows, window],
  );

  /** A preset replaces a dragged span rather than compounding with it. */
  const show = (next: number | null): void => {
    setMonths(next);
    setZoom(null);
  };

  if (points.length === 0) return <p className="text-muted">Ei vielä dataa.</p>;

  return (
    <div>
      {/* Above the chart, in one row: a control that sits on top of the plot
          is unreadable over the line it is meant to control. */}
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
        <span className="self-center text-muted">tai vedä kuvaajassa</span>
        {rows.some((row) => row.invested !== null) && (
          // Two series, so identity may not rest on colour: each line is
          // named. Kept in this row rather than under the plot, where it
          // collided with the axis the chart draws for itself.
          <span className="ml-auto flex items-center gap-3 self-center text-muted">
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4" style={{ background: colourFor(0) }} /> Arvo
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className="h-0.5 w-4"
                style={{
                  background: `repeating-linear-gradient(90deg, ${colourFor(1)} 0 4px, transparent 4px 7px)`,
                }}
              />
              Sijoitettu
            </span>
          </span>
        )}
      </div>
      <div className="h-72">
        <Chart definition={definition} ariaLabel={label} />
      </div>
    </div>
  );
};
