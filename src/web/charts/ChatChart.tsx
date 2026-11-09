import { useMemo } from "react";
import { defineChart } from "@tanstack/charts";
import { crosshair } from "@tanstack/charts/crosshair";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/react-charts";

import type { ChatChart as ChatChartValue } from "../../server/chat/chart-schema.ts";
import { chatChartRows, colourOf, xText } from "./chat-chart-model.ts";
import {
  annotationMarks,
  bandOf,
  extentOf,
  layoutFor,
  RIGHT,
  seriesMark,
  type Plot,
} from "./chat-chart-marks.ts";
import { TIME_FOCUS } from "./interactions.ts";

const DEFAULT_HEIGHT = 288;
const TICKS = 6;

const definitionFor = (chart: ChatChartValue) => {
  const layout = layoutFor(chart);
  const { spec } = chart;
  const { xs, log, leftFormat, rightFormat, rightUnit } = layout;
  const band = bandOf(layout);
  const extent = extentOf(layout, band.plots);
  const labelAt = (value: number): string => {
    const x = xs[Math.round(value)];
    return x === undefined ? "" : xText(x);
  };
  const hasBars = layout.barGroups.length > 0;
  const leftTick = (value: number) => leftFormat(log ? 10 ** value : value);
  const grid = spec.grid ?? true;
  // Always declared so every mark binds one of two known scales; hidden when nothing uses it.
  const right = {
    channel: "y" as const,
    side: "right" as const,
    scale: scaleLinear,
    nice: true,
    axis: rightUnit === undefined ? (false as const) : { ticks: { count: 5, format: rightFormat } },
  };
  return defineChart({
    marks: [
      ...band.marks,
      ...annotationMarks(layout, extent),
      ...chart.data.series.map((_series, index) => seriesMark(layout, index)),
      crosshair({ x: { label: { format: labelAt } }, y: false }),
    ],
    scales: {
      x: {
        scale: scaleLinear,
        domain: hasBars ? [-0.5, Math.max(0.5, xs.length - 0.5)] : [0, Math.max(1, xs.length - 1)],
        axis: { ticks: { count: TICKS, format: labelAt }, label: spec.xLabel },
      },
      y: {
        scale: scaleLinear,
        domain: extent.domain,
        nice: extent.domain === undefined,
        grid,
        axis: { ticks: { count: 5, format: leftTick }, label: spec.yLabel },
      },
      [RIGHT]: right,
    },
    ...TIME_FOCUS,
    tooltip: { use: tooltip, format: (point: { datum: Plot }) => point.datum.tip },
  });
};

const Legend = ({ chart }: { readonly chart: ChatChartValue }) => {
  const { labels } = chatChartRows(chart.data);
  return (
    <ul aria-label="Legend" className="flex flex-wrap gap-3 text-xs text-muted">
      {labels.map((label, index) => (
        <li key={`${label}-${index}`} className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-4 rounded-sm"
            style={{ background: colourOf(chart.spec.series[index]?.color, index) }}
          />
          {chart.spec.series[index]?.label ?? label}
        </li>
      ))}
      {chart.data.band !== undefined && (
        <li className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-4 rounded-sm opacity-30"
            style={{ background: colourOf(chart.spec.band?.color, 0) }}
          />
          {chart.spec.band?.label ?? chart.data.band.label}
        </li>
      )}
    </ul>
  );
};

/** A chart the assistant asked for: every value is the app's; titles, labels and the note are the model's plain text. */
export const ChatChart = ({ chart }: { readonly chart: ChatChartValue }) => {
  const definition = useMemo(() => definitionFor(chart), [chart]);
  const { title, subtitle, note, legend = "top" } = chart.spec;
  const height = chart.spec.height ?? DEFAULT_HEIGHT;
  return (
    <figure className="card max-w-[90%] grid gap-2 text-sm">
      <figcaption className="grid">
        <span className="font-semibold">{title}</span>
        {subtitle !== undefined && <span className="text-muted">{subtitle}</span>}
      </figcaption>
      {legend === "top" && <Legend chart={chart} />}
      <div style={{ height }}>
        <Chart definition={definition} height={height} ariaLabel={title} />
      </div>
      {legend === "bottom" && <Legend chart={chart} />}
      {chart.data.notes.map((line) => (
        <p key={line} className="text-xs text-muted">
          {line}
        </p>
      ))}
      {note !== undefined && note !== "" && (
        <div className="border-t border-line pt-2">
          <p className="text-xs text-muted">Assistant's note</p>
          <p className="whitespace-pre-wrap">{note}</p>
        </div>
      )}
    </figure>
  );
};
