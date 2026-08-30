import { useMemo, useState } from "react";
import { defineChart, lineY } from "@tanstack/charts";
import { crosshair } from "@tanstack/charts/crosshair";
import { brushX, type BrushRange } from "@tanstack/charts/interaction/brush";
import { controlledSignal } from "@tanstack/charts/interaction/signal";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/react-charts";
import { eur, fiDate } from "../lib/format";
import { TIME_FOCUS } from "./interactions";
import { colourFor } from "./palette";

export type SeriesPoint = { date: string; value: number };

/**
 * `@tanstack/react-charts@0.16` is a grammar-of-graphics library:
 * `defineChart({ marks, scales })` builds a definition and `<Chart definition>`
 * mounts it. There is no flat `options` prop.
 *
 * The x axis carries epoch milliseconds on a linear scale, but nothing a reader
 * sees is ever a millisecond: the ticks, the crosshair label and the tooltip all
 * format back to a Finnish date. The numbers exist so elapsed time spaces the
 * points -- a gap in the series then reads as a gap -- and because a
 * categorical axis cannot be narrowed to a range at all.
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
 * What a hovered point says.
 *
 * `xValue`/`yValue`, never `x`/`y`: the latter are pixel coordinates on the
 * painted scene. Reading those printed a position on screen as if it were a
 * date and a euro amount -- plausible-looking numbers that were wrong in both,
 * which is the worst way for a chart to be wrong.
 */
export const pointTip = (point: { xValue: unknown; yValue: unknown }): string =>
  `${asDate(Number(point.xValue))}: ${eur(String(point.yValue))}`;

/**
 * What a brush change means for the window, or `undefined` to ignore it.
 *
 * Only a committed range counts. Accepting previews re-filtered the data on
 * every pointer move, so the chart redrew underneath the drag and the selection
 * could never settle -- which is what made zooming feel broken rather than
 * merely imprecise. A click, which commits a zero-width range, clears the
 * window instead of selecting nothing.
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

export type PlotRow = { at: number; value: number };

/**
 * The points inside the chosen window, ending at the most recent one.
 *
 * The window is applied by filtering the data rather than by narrowing the x
 * domain, so the y axis rescales to what is actually on screen. Narrowing x
 * alone drew an early window as a flat line along the foot of a scale still
 * sized for years of later growth -- technically a zoom, and unreadable.
 */
export const windowed = (points: readonly SeriesPoint[], months: number | null): PlotRow[] => {
  const all = points.map((point) => ({ at: asMillis(point.date), value: point.value }));
  if (months === null || all.length === 0) return all;
  const from = new Date(all[all.length - 1]!.at);
  from.setUTCMonth(from.getUTCMonth() - months);
  return all.filter((row) => row.at >= from.getTime());
};

export const TimeSeriesChart = ({ points, label }: { points: SeriesPoint[]; label: string }) => {
  const [months, setMonths] = useState<number | null>(null);
  /** A range dragged on the chart itself, which beats any preset button. */
  const [dragged, setDragged] = useState<BrushRange<number> | null>(null);
  /**
   * Whether a drag is in progress right now.
   *
   * The brush's chrome is painted only while it is: a selection rectangle and
   * two handles sitting on the plot when nobody is dragging is a control
   * shouting for attention while doing nothing, and once a range is committed
   * the narrowed chart already says what was chosen.
   */
  const [dragging, setDragging] = useState(false);

  const byMonths = useMemo(() => windowed(points, months), [points, months]);
  const rows = useMemo(
    () =>
      dragged === null
        ? byMonths
        : byMonths.filter((row) => row.at >= dragged.start && row.at <= dragged.end),
    [byMonths, dragged],
  );
  const full = useMemo(() => windowed(points, null), [points]);
  /**
   * With nothing selected the brush sits on a zero-width range, so the plot is
   * clean until the reader drags. Handing it the full extent instead drew a
   * selection across the whole chart with a handle at each edge -- a control
   * shouting for attention while doing nothing.
   */
  const empty = useMemo(
    (): BrushRange<number> => ({ start: full[0]?.at ?? 0, end: full[0]?.at ?? 0 }),
    [full],
  );

  const definition = useMemo(
    () =>
      defineChart({
        marks: [
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
          x: {
            scale: scaleLinear,
            axis: { ticks: { count: 6, format: asDate } },
          },
          y: {
            scale: scaleLinear,
            nice: true,
            grid: true,
            axis: { ticks: { count: 5, format: compactEur } },
          },
        },
        // Drag across the plot to keep exactly that span. The application owns
        // the accepted range; the control only proposes one.
        controls: [
          brushX<number>({
            range: controlledSignal(dragged ?? empty, (next, context) => {
              setDragging(context.reason.type === "preview");
              const accepted = acceptedRange(next, context.reason.type);
              if (accepted !== undefined) setDragged(accepted);
            }),
            selectionStyle: {
              fill: "var(--color-accent)",
              fillOpacity: dragging ? 0.14 : 0,
              stroke: "none",
            },
            handleStyle: { fill: "var(--color-accent)", fillOpacity: dragging ? 0.5 : 0 },
            // Constant: the control rejects a non-positive size, so the handles
            // are hidden by opacity rather than by shrinking them away.
            handleSize: 6,
            keyboard: false,
            ariaLabel: "Valitse aikaväli",
            format: asDate,
          }),
        ],
        ...TIME_FOCUS,
        tooltip: { use: tooltip, format: pointTip },
      }),
    [rows, dragged, dragging, empty],
  );

  /** A preset range replaces whatever was dragged, rather than compounding with it. */
  const show = (next: number | null): void => {
    setMonths(next);
    setDragged(null);
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
            aria-pressed={dragged === null && months === range.months}
            className={`border border-line px-2 py-0.5 ${
              dragged === null && months === range.months ? "bg-line" : ""
            }`}
            onClick={() => show(range.months)}
          >
            {range.label}
          </button>
        ))}
        <span className="self-center text-muted">tai vedä kuvaajassa</span>
      </div>
      <div className="h-72">
        <Chart definition={definition} ariaLabel={label} />
      </div>
    </div>
  );
};
