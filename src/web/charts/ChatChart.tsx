import { useMemo } from "react";
import { defineChart } from "@tanstack/charts";
import { crosshair } from "@tanstack/charts/crosshair";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/react-charts";

import type { ChatChart as ChatChartValue } from "../../server/chat/chart-schema.ts";
import { atText, chatChartRows, colourOf, NOTE_MARK } from "./chat-chart-model.ts";
import {
  annotationMarks,
  bandOf,
  extentOf,
  layoutFor,
  RIGHT,
  seriesMarks,
  type Plot,
} from "./chat-chart-marks.ts";
import { ChartFrame } from "./ChartFrame.tsx";
import { GROUP_FOCUS } from "./interactions.ts";

const DEFAULT_HEIGHT = 288;
const TICKS = 6;

const definitionFor = (chart: ChatChartValue) => {
  const layout = layoutFor(chart);
  const { spec } = chart;
  const { rows, log, leftFormat, rightFormat, rightUnit } = layout;
  const band = bandOf(layout);
  const extent = extentOf(layout, band.plots);
  const labelAt = (value: number): string => atText(rows, value);
  // Bars need half a slot of room at each end.
  const pad = layout.barGroups.length > 0 ? rows.slot / 2 : 0;
  const xDomain: readonly [number, number] = [
    rows.first - pad,
    Math.max(rows.last, rows.first + (rows.time ? rows.slot : 1)) + pad,
  ];
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
      ...chart.data.series.flatMap((_series, index) => seriesMarks(layout, index)),
      crosshair({ x: { label: { format: labelAt } }, y: false }),
    ],
    scales: {
      x: {
        scale: scaleLinear,
        domain: xDomain,
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
    ...GROUP_FOCUS,
    tooltip: { use: tooltip, format: (point: { datum: Plot }) => point.datum.tip },
  });
};

/** The model's legend name, with the app's own label after it whenever they differ. */
const Legend = ({ chart }: { readonly chart: ChatChartValue }) => {
  const { labels } = chatChartRows(chart.data);
  const entries = [
    ...labels.map((appLabel, index) => ({
      appLabel,
      label: chart.spec.series[index]?.label ?? appLabel,
      colour: colourOf(chart.spec.series[index]?.color, index),
      faded: false,
    })),
    ...(chart.data.band === undefined
      ? []
      : [
          {
            appLabel: chart.data.band.label,
            label: chart.spec.band?.label ?? chart.data.band.label,
            colour: colourOf(chart.spec.band?.color, 0),
            faded: true,
          },
        ]),
  ];
  return (
    <ul aria-label="Legend" className="flex flex-wrap gap-3 text-xs">
      {entries.map((entry, index) => (
        <li
          key={`${entry.appLabel}-${index}`}
          data-legend-item=""
          className="flex items-center gap-1.5"
        >
          <span
            className={
              entry.faded
                ? "inline-block h-2 w-4 rounded-sm opacity-30"
                : "inline-block h-2 w-4 rounded-sm"
            }
            style={{ background: entry.colour }}
          />
          {entry.label}
          {entry.label !== entry.appLabel && <span className="text-muted">({entry.appLabel})</span>}
        </li>
      ))}
    </ul>
  );
};

/** The model's annotation words again, in italics, so they never read as the app's figures. */
const AnnotationList = ({ chart }: { readonly chart: ChatChartValue }) =>
  (chart.spec.annotations ?? []).length === 0 ? null : (
    <ul aria-label="Chart notes" className="grid gap-0.5 text-xs text-muted italic">
      {(chart.spec.annotations ?? []).map((note, index) => (
        <li key={`${note.label}-${index}`}>
          {NOTE_MARK} {note.label}
        </li>
      ))}
    </ul>
  );

/** A chart the assistant asked for: every value is the app's; titles, labels and the note are the model's plain text. */
export const ChatChart = ({ chart }: { readonly chart: ChatChartValue }) => {
  const definition = useMemo(() => definitionFor(chart), [chart]);
  const { title, subtitle, note, legend = "top" } = chart.spec;
  const height = chart.spec.height ?? DEFAULT_HEIGHT;
  return (
    <figure className="card max-w-[90%] text-sm">
      <ChartFrame title={title} className="grid gap-2">
        <figcaption className="grid">
          <span className="font-semibold">{title}</span>
          {subtitle !== undefined && <span className="text-muted">{subtitle}</span>}
        </figcaption>
        {legend === "top" && <Legend chart={chart} />}
        <div style={{ height }}>
          <Chart definition={definition} height={height} ariaLabel={title} />
        </div>
        {legend === "bottom" && <Legend chart={chart} />}
        <AnnotationList chart={chart} />
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
      </ChartFrame>
    </figure>
  );
};
