import { areaY, dot, lineY, rect, ruleX, ruleY, text } from "@tanstack/charts";

import type { ChatChart as ChatChartValue } from "../../server/chat/chart-schema.ts";
import {
  chatChartRows,
  colourOf,
  DASH,
  formatFor,
  positionOf,
  stackedRows,
  tipFormatFor,
  xText,
} from "./chat-chart-model.ts";
import { bumpX, stepX } from "./curve.ts";

const BAR_SLOT = 0.8;
export const RIGHT = "yRight";
type Axis = "y" | typeof RIGHT;
const LEFT: Axis = "y";
const CURVES = { linear: undefined, smooth: bumpX, step: stepX } as const;

/** One row shape for every mark, so the definition stays one type. */
export type Plot = {
  readonly at: number;
  readonly x1: number;
  readonly x2: number;
  readonly y1: number;
  readonly y2: number;
  readonly tip: string;
  readonly label: string;
};

/** Chart-level kind as each series' default; "stacked-bar" stacks every bar without its own stack id. */
const seriesKind = (chart: ChatChartValue, index: number) => {
  const own = chart.spec.series[index]?.kind;
  if (own !== undefined) return own;
  const kind = chart.spec.kind ?? "line";
  return kind === "stacked-bar" ? "bar" : kind;
};

/** Everything the marks share, worked out once from the app's data and the model's styling. */
export const layoutFor = (chart: ChatChartValue) => {
  const { spec, data } = chart;
  const { xs, labels, rows } = chatChartRows(data);
  const log = data.yScale === "log";
  const rightUnit = data.series.find((_s, i) => spec.series[i]?.axis === "right")?.unit;
  const rightFormat = formatFor(undefined, rightUnit ?? spec.yUnit);
  const kinds = data.series.map((_series, index) => seriesKind(chart, index));
  const axisOf = (index: number) => spec.series[index]?.axis ?? "left";
  const stackIds = data.series.map((_series, index) => {
    const own =
      spec.series[index]?.stack ??
      (spec.kind === "stacked-bar" && kinds[index] === "bar" ? "all" : undefined);
    return own === undefined ? undefined : `${axisOf(index)}:${own}`;
  });
  // Bars that do not share a stack stand side by side in the x slot.
  const barGroups = [
    ...new Set(
      kinds.flatMap((kind, index) => (kind === "bar" ? [stackIds[index] ?? `own-${index}`] : [])),
    ),
  ];
  return {
    chart,
    xs,
    labels,
    rows,
    log,
    rightUnit,
    rightFormat,
    leftFormat: formatFor(spec.yFormat, spec.yUnit),
    kinds,
    axisOf,
    stackIds,
    stacked: stackedRows(rows, stackIds),
    barGroups,
    width: BAR_SLOT / Math.max(1, barGroups.length),
    plotted: (value: number, index: number): number =>
      log && axisOf(index) === "left" ? Math.log10(value) : value,
    tipFor: (index: number) =>
      axisOf(index) === "left" ? tipFormatFor(spec.yFormat, spec.yUnit) : rightFormat,
  };
};

export type Layout = ReturnType<typeof layoutFor>;

const plotsFor = (layout: Layout, index: number, label: string): Plot[] => {
  const { barGroups, stackIds, width, rows, xs, plotted, tipFor } = layout;
  const group = barGroups.indexOf(stackIds[index] ?? `own-${index}`);
  return (layout.stacked[index] ?? []).map((row, at) => {
    const raw = rows[index]?.[at]?.y ?? 0;
    const x1 = row.at - BAR_SLOT / 2 + group * width;
    return {
      at: row.at,
      x1,
      x2: x1 + width,
      y1: plotted(row.y1, index),
      y2: plotted(row.y2, index),
      label,
      tip: `${label} · ${xText(xs[row.at] ?? "")}: ${tipFor(index)(raw)}`,
    };
  });
};

/** One series as the mark its kind asks for, styled as the model asked. */
export const seriesMark = (layout: Layout, index: number) => {
  const { axisOf, kinds } = layout;
  const style = layout.chart.spec.series[index];
  const label = style?.label ?? layout.labels[index] ?? "";
  const colour = colourOf(style?.color, index);
  const plots = plotsFor(layout, index, label);
  const yScale: Axis = axisOf(index) === "right" ? RIGHT : LEFT;
  const common = { id: `series-${index}`, yScale };
  const kind = kinds[index];
  const curve = kind === "step" ? stepX : CURVES[style?.curve ?? "linear"];
  switch (kind) {
    case "area":
      return areaY(plots, {
        ...common,
        x: "at",
        y1: "y1",
        y2: "y2",
        fill: colour,
        fillOpacity: style?.fillOpacity ?? 0.3,
        stroke: colour,
        strokeWidth: style?.width ?? 1.5,
        curve,
      });
    case "scatter":
      return dot(plots, {
        ...common,
        x: "at",
        y: "y2",
        r: (style?.width ?? 2) + 1,
        fill: colour,
        fillOpacity: style?.opacity ?? 0.9,
      });
    case "bar":
      return rect(plots, {
        ...common,
        x1: "x1",
        x2: "x2",
        y1: "y1",
        y2: "y2",
        fill: colour,
        fillOpacity: style?.opacity ?? style?.fillOpacity ?? 0.85,
      });
    default:
      return lineY(plots, {
        ...common,
        x: "at",
        y: "y2",
        stroke: colour,
        strokeWidth: style?.width ?? 2,
        strokeOpacity: style?.opacity ?? 1,
        strokeDasharray: DASH[style?.dash ?? "solid"],
        points: style?.points ?? false,
        curve,
      });
  }
};

/** The shaded low-high range of a forecast. */
export const bandOf = (layout: Layout) => {
  const { chart, xs, log, tipFor } = layout;
  const { spec, data } = chart;
  const position = new Map(xs.map((x, at) => [x, at]));
  const label = spec.band?.label ?? data.band?.label ?? "";
  const plots: Plot[] = (data.band?.points ?? []).map((point) => ({
    at: position.get(point.x) ?? 0,
    x1: 0,
    x2: 0,
    y1: log ? Math.log10(point.low) : point.low,
    y2: log ? Math.log10(point.high) : point.high,
    label,
    tip: `${label} · ${xText(point.x)}: ${tipFor(-1)(point.low)} – ${tipFor(-1)(point.high)}`,
  }));
  const marks =
    data.band === undefined
      ? []
      : [
          areaY(plots, {
            id: "band",
            yScale: LEFT,
            x: "at",
            y1: "y1",
            y2: "y2",
            fill: colourOf(spec.band?.color, 0),
            fillOpacity: spec.band?.fillOpacity ?? 0.16,
          }),
        ];
  return { plots, marks };
};

/** The left axis' plotted range, with the model's yMin/yMax where they make sense on this scale. */
export const extentOf = (layout: Layout, band: readonly Plot[]) => {
  const { stacked, axisOf, plotted, log, chart } = layout;
  const values = [
    ...stacked.flatMap((series, index) =>
      axisOf(index) === "left"
        ? series.flatMap((row) => [plotted(row.y1, index), plotted(row.y2, index)])
        : [],
    ),
    ...band.flatMap((row) => [row.y1, row.y2]),
  ];
  const lowest = Math.min(...values, ...(log ? [] : [0]));
  const highest = Math.max(...values, lowest + 1);
  const bound = (value: number | undefined) =>
    value === undefined || (log && value <= 0) ? undefined : log ? Math.log10(value) : value;
  const yMin = bound(chart.spec.yMin);
  const yMax = bound(chart.spec.yMax);
  const domain: readonly [number, number] | undefined =
    yMin === undefined && yMax === undefined ? undefined : [yMin ?? lowest, yMax ?? highest];
  return { domain, top: domain?.[1] ?? highest, bottom: domain?.[0] ?? lowest, bound };
};

/** Lines and ranges the app places at validated values; their labels are the model's words. */
export const annotationMarks = (layout: Layout, extent: ReturnType<typeof extentOf>) => {
  const { xs, rightUnit } = layout;
  const { top, bottom, bound } = extent;
  return (layout.chart.spec.annotations ?? []).flatMap((note, index) => {
    const colour = colourOf(note.color, 7);
    const id = `note-${index}`;
    const at = (x: string) => positionOf(xs, x);
    switch (note.type) {
      case "y-line": {
        const y = note.axis === "right" ? note.y : (bound(note.y) ?? note.y);
        const yScale: Axis = note.axis === "right" && rightUnit !== undefined ? RIGHT : LEFT;
        const row: Plot = { at: 0, x1: 0, x2: 0, y1: y, y2: y, label: note.label, tip: note.label };
        return [
          ruleY([row], { id, y: "y2", stroke: colour, strokeDasharray: "4 3", yScale }),
          text([row], {
            id: `${id}-label`,
            x: "at",
            y: "y2",
            text: "label",
            fill: colour,
            fontSize: 11,
            anchor: "start",
            dy: -4,
            yScale,
          }),
        ];
      }
      case "x-line": {
        const row: Plot = {
          at: at(note.x),
          x1: 0,
          x2: 0,
          y1: top,
          y2: top,
          label: note.label,
          tip: note.label,
        };
        return [
          ruleX([row], { id, x: "at", stroke: colour, strokeDasharray: "4 3" }),
          text([row], {
            id: `${id}-label`,
            x: "at",
            y: "y2",
            text: "label",
            fill: colour,
            fontSize: 11,
            anchor: "start",
            dx: 4,
            dy: 12,
          }),
        ];
      }
      case "x-range": {
        const row: Plot = {
          at: at(note.from),
          x1: at(note.from),
          x2: at(note.to),
          y1: bottom,
          y2: top,
          label: note.label,
          tip: note.label,
        };
        return [
          rect([row], {
            id,
            yScale: LEFT,
            x1: "x1",
            x2: "x2",
            y1: "y1",
            y2: "y2",
            fill: colour,
            fillOpacity: 0.12,
          }),
          text([row], {
            id: `${id}-label`,
            x: "x1",
            y: "y2",
            text: "label",
            fill: colour,
            fontSize: 11,
            anchor: "start",
            dx: 4,
            dy: 12,
          }),
        ];
      }
    }
  });
};
