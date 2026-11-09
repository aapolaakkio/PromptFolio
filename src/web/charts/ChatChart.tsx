import { useMemo } from "react";
import { areaY, barY, colorLegend, defineChart, group, lineY, stack } from "@tanstack/charts";
import { crosshair } from "@tanstack/charts/crosshair";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scaleOrdinal } from "@tanstack/charts/scales/ordinal";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/react-charts";

import type { ChartData, ChatChart as ChatChartValue } from "../../server/chat/chart-schema.ts";
import { eur, formatDate } from "../lib/format.ts";
import { shortMonth } from "./CategoryTrendChart.tsx";
import { MARK_FOCUS, TIME_FOCUS } from "./interactions.ts";
import { colourFor } from "./palette.ts";
import { compactEur } from "./TimeSeriesChart.tsx";

const TIME_X = /^\d{4}-\d{2}(-\d{2})?$/;
const TICKS = 6;

type Row = { readonly at: number; readonly x: string; readonly series: string; readonly y: number };

/** Long rows on one shared x axis: dates and months sorted, category labels in the app's order. */
export const chatChartRows = (data: ChartData) => {
  const seen = data.series.flatMap((series) => series.points.map((point) => point.x));
  const unique = [...new Set(seen)];
  const xs = unique.every((x) => TIME_X.test(x)) ? unique.toSorted() : unique;
  const index = new Map(xs.map((x, at) => [x, at]));
  // Two references can resolve to the same label; the legend needs them apart.
  const labels = data.series.map((series, at) => {
    const before = data.series.slice(0, at).filter((other) => other.label === series.label).length;
    return before === 0 ? series.label : `${series.label} (${before + 1})`;
  });
  const rows: Row[] = data.series.flatMap((series, at) =>
    series.points.map((point) => ({
      at: index.get(point.x) ?? 0,
      x: point.x,
      series: labels[at] ?? series.label,
      y: point.y,
    })),
  );
  return { xs, labels, rows };
};

const xText = (x: string): string =>
  /^\d{4}-\d{2}$/.test(x) ? shortMonth(x) : TIME_X.test(x) ? formatDate(x) : x;

const UNIT_FORMAT = {
  EUR: { tick: compactEur, tip: (value: number) => eur(String(value)) },
  "%": { tick: (value: number) => `${value} %`, tip: (value: number) => `${value.toFixed(2)} %` },
  count: { tick: (value: number) => String(value), tip: (value: number) => String(value) },
} as const;

const sharedFor = (chart: ChatChartValue) => {
  const { xs, labels, rows } = chatChartRows(chart.data);
  const unit = UNIT_FORMAT[chart.spec.yUnit];
  const labelAt = (at: number): string => {
    const x = xs[Math.round(at)];
    return x === undefined ? "" : xText(x);
  };
  const color = {
    scale: scaleOrdinal<string, string>()
      .domain(labels)
      .range(labels.map((_label, at) => colourFor(at))),
    legend: colorLegend({ label: "" }),
  };
  const y = {
    scale: scaleLinear,
    nice: true,
    grid: true,
    axis: { ticks: { count: 5, format: unit.tick } },
  };
  // Bars key x by its label, lines by its index on the shared axis.
  const tipWith =
    (xLabel: (x: string) => string) =>
    (point: { xValue: unknown; yValue: unknown }): string =>
      `${xLabel(String(point.xValue))}: ${unit.tip(Number(point.yValue))}`;
  return { xs, rows, labelAt, color, y, tipWith };
};

const barDefinition = (chart: ChatChartValue) => {
  const { xs, rows, color, y, tipWith } = sharedFor(chart);
  const tip = tipWith(xText);
  const { kind } = chart.spec;
  // Every nth label only: 400 bars cannot each carry one.
  const step = Math.max(1, Math.ceil(xs.length / TICKS));
  return defineChart({
    marks: [
      barY(rows, {
        x: "x",
        y: "y",
        color: "series",
        layout: kind === "bar" ? group() : stack(),
        radius: 4,
        inset: 1,
      }),
    ],
    scales: {
      x: {
        scale: () => scaleBand<string>().domain(xs),
        axis: {
          ticks: {
            format: (x: string) => (xs.indexOf(x) % step === 0 ? xText(x) : ""),
          },
        },
      },
      y,
    },
    color,
    ...MARK_FOCUS,
    tooltip: { use: tooltip, format: tip },
  });
};

const lineDefinition = (chart: ChatChartValue) => {
  const { xs, rows, labelAt, color, y, tipWith } = sharedFor(chart);
  const tip = tipWith((x) => labelAt(Number(x)));
  const { kind } = chart.spec;
  const mark =
    kind === "area"
      ? areaY(rows, { x: "at", y: "y", color: "series", fillOpacity: 0.3 })
      : lineY(rows, { x: "at", y: "y", color: "series", strokeWidth: 2 });
  return defineChart({
    marks: [mark, crosshair({ x: { label: { format: labelAt } }, y: false })],
    scales: {
      x: {
        scale: scaleLinear,
        domain: [0, Math.max(1, xs.length - 1)],
        axis: { ticks: { count: TICKS, format: labelAt } },
      },
      y,
    },
    color,
    ...TIME_FOCUS,
    tooltip: { use: tooltip, format: tip },
  });
};

/** A chart the assistant asked for: numbers the app computed; the title and note are the model's plain text. */
const BarPlot = ({ chart }: { readonly chart: ChatChartValue }) => {
  const definition = useMemo(() => barDefinition(chart), [chart]);
  return <Chart definition={definition} height={288} ariaLabel={chart.spec.title} />;
};

const LinePlot = ({ chart }: { readonly chart: ChatChartValue }) => {
  const definition = useMemo(() => lineDefinition(chart), [chart]);
  return <Chart definition={definition} height={288} ariaLabel={chart.spec.title} />;
};

export const ChatChart = ({ chart }: { readonly chart: ChatChartValue }) => {
  const { title, note, kind } = chart.spec;
  return (
    <figure className="card max-w-[90%] grid gap-2 text-sm">
      <figcaption className="font-semibold">{title}</figcaption>
      <div className="h-72">
        {kind === "bar" || kind === "stacked-bar" ? (
          <BarPlot chart={chart} />
        ) : (
          <LinePlot chart={chart} />
        )}
      </div>
      {note !== undefined && note !== "" && (
        <div className="border-t border-line pt-2">
          <p className="text-xs text-muted">Assistant's note</p>
          <p className="whitespace-pre-wrap">{note}</p>
        </div>
      )}
    </figure>
  );
};
