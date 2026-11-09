import { areaY, dot, lineY, rect, ruleX, ruleY, text } from "@tanstack/charts";

import type { ChatChart as ChatChartValue } from "../../server/chat/chart-schema.ts";
import {
  atText,
  chatChartRows,
  colourOf,
  DASH,
  formatFor,
  logFloor,
  NOTE_COLOUR,
  NOTE_MARK,
  stackedRows,
  tipFormatFor,
} from "./chat-chart-model.ts";
import { bumpX, stepX } from "./curve.ts";

const BAR_FILL = 0.8;
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
  /** The value again on estimated days only, for the dashed overlay; null elsewhere breaks the line. */
  readonly ey: number | null;
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
  const rows = chatChartRows(data);
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
  const leftRaw = [
    ...rows.rows.flatMap((series, index) =>
      axisOf(index) === "left" ? series.map((r) => r.y) : [],
    ),
    ...(data.band?.points ?? []).map((point) => point.low),
  ];
  // A log axis has no zero: bars, areas and stacks start from this floor instead.
  const floor = logFloor(leftRaw, spec.yMin);
  const onLeft = (value: number): number => (log ? Math.log10(Math.max(value, floor)) : value);
  return {
    chart,
    rows,
    log,
    floor,
    onLeft,
    rightUnit,
    rightFormat,
    leftFormat: formatFor(spec.yFormat, spec.yUnit),
    kinds,
    axisOf,
    stackIds,
    stacked: stackedRows(rows.rows, stackIds),
    barGroups,
    width: (rows.slot * BAR_FILL) / Math.max(1, barGroups.length),
    plotted: (value: number, index: number): number =>
      axisOf(index) === "left" ? onLeft(value) : value,
    tipFor: (index: number) =>
      axisOf(index) === "left" ? tipFormatFor(spec.yFormat, spec.yUnit) : rightFormat,
  };
};

export type Layout = ReturnType<typeof layoutFor>;

/** One series' rows; the tooltip always names the app's own label, whatever the legend says. */
export const plotsFor = (layout: Layout, index: number): Plot[] => {
  const { barGroups, stackIds, width, rows, plotted, tipFor } = layout;
  const appLabel = rows.labels[index] ?? "";
  const group = barGroups.indexOf(stackIds[index] ?? `own-${index}`);
  const series = rows.rows[index] ?? [];
  return (layout.stacked[index] ?? []).map((row, at) => {
    const point = series[at];
    const raw = point?.y ?? 0;
    const x1 = row.at - (rows.slot * BAR_FILL) / 2 + group * width;
    return {
      at: row.at,
      x1,
      x2: x1 + width,
      y1: plotted(row.y1, index),
      y2: plotted(row.y2, index),
      ey: point?.estimated === true ? plotted(row.y2, index) : null,
      label: appLabel,
      tip: `${appLabel} · ${atText(rows, row.at)}: ${tipFor(index)(raw)}${point?.estimated === true ? " (estimated)" : ""}`,
    };
  });
};

const lineStyle = (layout: Layout, index: number) => {
  const style = layout.chart.spec.series[index];
  return {
    stroke: colourOf(style?.color, index),
    strokeWidth: style?.width ?? 2,
    strokeOpacity: style?.opacity ?? 1,
  };
};

/** Estimated days (stale prices, holdings valued at cost) drawn dashed over the line, as on the dashboard. */
const estimatedMarks = (layout: Layout, index: number, plots: readonly Plot[], yScale: Axis) =>
  plots.some((row) => row.ey !== null) && layout.kinds[index] !== "bar"
    ? [
        lineY(plots, {
          id: `series-${index}-estimated`,
          yScale,
          x: "at",
          y: "ey",
          ...lineStyle(layout, index),
          strokeDasharray: DASH.dashed,
        }),
      ]
    : [];

/** One series as the mark its kind asks for, styled as the model asked. */
export const seriesMarks = (layout: Layout, index: number) => {
  const style = layout.chart.spec.series[index];
  const colour = colourOf(style?.color, index);
  const plots = plotsFor(layout, index);
  const yScale: Axis = layout.axisOf(index) === "right" ? RIGHT : LEFT;
  const common = { id: `series-${index}`, yScale };
  const kind = layout.kinds[index];
  const curve = kind === "step" ? stepX : CURVES[style?.curve ?? "linear"];
  const extra = estimatedMarks(layout, index, plots, yScale);
  switch (kind) {
    case "area":
      return [
        areaY(plots, {
          ...common,
          x: "at",
          y1: "y1",
          y2: "y2",
          fill: colour,
          fillOpacity: style?.fillOpacity ?? 0.3,
          stroke: colour,
          strokeWidth: style?.width ?? 1.5,
          curve,
        }),
        ...extra,
      ];
    case "scatter":
      return [
        dot(plots, {
          ...common,
          x: "at",
          y: "y2",
          r: (style?.width ?? 2) + 1,
          fill: colour,
          fillOpacity: style?.opacity ?? 0.9,
        }),
        ...extra,
      ];
    case "bar":
      return [
        rect(plots, {
          ...common,
          x1: "x1",
          x2: "x2",
          y1: "y1",
          y2: "y2",
          fill: colour,
          fillOpacity: style?.opacity ?? style?.fillOpacity ?? 0.85,
        }),
      ];
    default:
      return [
        lineY(plots, {
          ...common,
          x: "at",
          y: "y2",
          ...lineStyle(layout, index),
          strokeDasharray: DASH[style?.dash ?? "solid"],
          points: style?.points ?? false,
          curve,
        }),
        ...extra,
      ];
  }
};

/** The shaded low-high range of a forecast. */
export const bandOf = (layout: Layout) => {
  const { chart, rows, onLeft, tipFor } = layout;
  const { spec, data } = chart;
  const label = data.band?.label ?? "";
  const plots: Plot[] = (data.band?.points ?? []).map((point) => ({
    at: rows.atOf(point.x),
    x1: 0,
    x2: 0,
    y1: onLeft(point.low),
    y2: onLeft(point.high),
    ey: null,
    label,
    tip: `${label} · ${atText(rows, rows.atOf(point.x))}: ${tipFor(-1)(point.low)} – ${tipFor(-1)(point.high)}`,
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

/** The left axis always holds every value; the model's bounds may only widen it. Never a non-finite end. */
export const extentOf = (layout: Layout, band: readonly Plot[]) => {
  const { stacked, axisOf, plotted, log, chart, onLeft } = layout;
  const values = [
    ...stacked.flatMap((series, index) =>
      axisOf(index) === "left"
        ? series.flatMap((row) => [plotted(row.y1, index), plotted(row.y2, index)])
        : [],
    ),
    ...band.flatMap((row) => [row.y1, row.y2]),
  ].filter(Number.isFinite);
  const lowest = values.length === 0 ? 0 : Math.min(...values, ...(log ? [] : [0]));
  const highest = values.length === 0 ? 1 : Math.max(...values, lowest + (log ? 0.1 : 1));
  const bound = (value: number | undefined) =>
    value === undefined || (log && value <= 0) ? undefined : onLeft(value);
  const yMin = bound(chart.spec.yMin);
  const yMax = bound(chart.spec.yMax);
  const domain: readonly [number, number] | undefined =
    yMin === undefined && yMax === undefined
      ? undefined
      : [Math.min(yMin ?? lowest, lowest), Math.max(yMax ?? highest, highest)];
  return { domain, top: domain?.[1] ?? highest, bottom: domain?.[0] ?? lowest };
};

const noteText = (id: string, rows: readonly Plot[], x: "at" | "x1", yScale: Axis, dy: number) =>
  text(rows, {
    id: `${id}-label`,
    x,
    y: "y2",
    text: "label",
    fill: NOTE_COLOUR,
    fontSize: 11,
    anchor: "start",
    dx: 4,
    dy,
    yScale,
  });

/** Lines and ranges the app places at validated values; their labels are the model's words, muted and marked as notes. */
export const annotationMarks = (layout: Layout, extent: ReturnType<typeof extentOf>) => {
  const { rows, rightUnit, onLeft } = layout;
  const { top, bottom } = extent;
  return (layout.chart.spec.annotations ?? []).flatMap((note, index) => {
    const colour = colourOf(note.color, 7);
    const id = `note-${index}`;
    const label = `${NOTE_MARK} ${note.label}`;
    const base = { x1: 0, x2: 0, ey: null, label, tip: label };
    switch (note.type) {
      case "y-line": {
        // With no right-axis series the line belongs on the left scale, log included.
        const onRight = note.axis === "right" && rightUnit !== undefined;
        const y = onRight ? note.y : onLeft(note.y);
        const yScale: Axis = onRight ? RIGHT : LEFT;
        const row: Plot = { ...base, at: rows.first, y1: y, y2: y };
        return [
          ruleY([row], { id, y: "y2", stroke: colour, strokeDasharray: "4 3", yScale }),
          noteText(id, [row], "at", yScale, -4),
        ];
      }
      case "x-line": {
        const row: Plot = { ...base, at: rows.atOf(note.x), y1: top, y2: top };
        return [
          ruleX([row], { id, x: "at", stroke: colour, strokeDasharray: "4 3" }),
          noteText(id, [row], "at", LEFT, 12),
        ];
      }
      case "x-range": {
        const row: Plot = {
          ...base,
          at: rows.atOf(note.from),
          x1: rows.atOf(note.from),
          x2: rows.atOf(note.to),
          y1: bottom,
          y2: top,
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
          noteText(id, [row], "x1", LEFT, 12),
        ];
      }
    }
  });
};
