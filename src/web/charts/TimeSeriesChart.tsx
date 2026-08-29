import { useMemo, useState } from "react";
import { defineChart, lineY } from "@tanstack/charts";
import { crosshair } from "@tanstack/charts/crosshair";
import { controlledSignal } from "@tanstack/charts/interaction/signal";
import { zoomX, type ZoomXWindow } from "@tanstack/charts/interaction/zoom";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/react-charts";
import { eur, fiDate } from "../lib/format";
import { TIME_FOCUS, worthZooming } from "./interactions";
import { colourFor } from "./palette";

export type SeriesPoint = { date: string; value: number };

/**
 * `@tanstack/react-charts@0.16` is a grammar-of-graphics library:
 * `defineChart({ marks, scales })` from `@tanstack/charts` builds a definition
 * and `<Chart definition={...} />` mounts it. There is no flat `options` prop.
 *
 * The x axis is epoch milliseconds on a linear scale rather than the dates as
 * point-scale categories. Two reasons, and only the second is new: elapsed time
 * then spaces the points, so a gap in the series reads as a gap; and `zoomX`
 * requires a continuous domain, so a categorical axis cannot be zoomed at all.
 * The library ships no time scale, so the conversion happens here and the ticks
 * are formatted back into dates.
 */
const asMillis = (iso: string): number => new Date(`${iso}T00:00:00Z`).getTime();

export const TimeSeriesChart = ({ points, label }: { points: SeriesPoint[]; label: string }) => {
  const rows = useMemo(
    () => points.map((point) => ({ at: asMillis(point.date), value: point.value })),
    [points],
  );
  const extent = useMemo(
    (): readonly [number, number] => [rows[0]?.at ?? 0, rows[rows.length - 1]?.at ?? 0],
    [rows],
  );
  // The application owns the accepted window; the control only proposes one.
  const [window, setWindow] = useState<ZoomXWindow<number> | null>(null);
  const zoomable = worthZooming(rows.length);

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
          // Follows the pointer and labels the date it is over, so a value can
          // be read off without counting gridlines.
          crosshair({ x: { label: true }, y: false }),
        ],
        scales: {
          x: {
            scale: scaleLinear,
            domain: window === null ? undefined : [window.start, window.end],
            axis: { ticks: { count: 6, format: (value: number) => fiDate(isoOf(value)) } },
          },
          y: {
            scale: scaleLinear,
            nice: true,
            grid: true,
            axis: { ticks: { format: (value: number) => eur(String(value)) } },
          },
        },
        controls: zoomable
          ? [
              zoomX({
                window: controlledSignal(window ?? { start: extent[0], end: extent[1] }, (next) =>
                  setWindow(next),
                ),
                extent,
                keyboard: true,
                ariaLabel: "Zoomaa aikaväliä",
                format: (value: number) => fiDate(isoOf(value)),
              }),
            ]
          : [],
        // Keeps inspection alive across empty plot: a daily series has a lot of
        // vertical space, and a tooltip that vanishes when the pointer leaves
        // the line reads as broken rather than as precise.
        ...TIME_FOCUS,
        tooltip,
      }),
    [rows, extent, window, zoomable],
  );

  if (points.length === 0) return <p className="text-muted">Ei vielä dataa.</p>;

  return (
    <div>
      <div className="h-80">
        <Chart definition={definition} ariaLabel={label} aspectRatio={16 / 6} initialWidth={640} />
      </div>
      {zoomable && (
        <p className="mt-1 text-xs text-muted">
          Vieritä tai vedä kuvaajassa zoomataksesi.
          {window !== null && (
            <>
              {" "}
              <button type="button" className="underline" onClick={() => setWindow(null)}>
                Näytä koko jakso
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
};

/** Back to the ISO day the point came from, for a tick or tooltip label. */
const isoOf = (millis: number): string => new Date(millis).toISOString().slice(0, 10);
