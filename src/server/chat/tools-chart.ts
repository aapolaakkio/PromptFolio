import {
  ChartSpecSchema,
  ChatChartSchema,
  MAX_CHART_SERIES,
  type ChartData,
  type ChartSpec,
  type YUnit,
} from "./chart-schema.ts";
import { forecastBand, resolveSeries, type ResolvedSeries } from "./chart-series.ts";
import {
  applyTransform,
  thin,
  TRANSFORM_SUFFIX,
  transformedUnit,
  type Transform,
} from "./chart-transform.ts";
import { type ChartTool, type Db, today } from "./tool-types.ts";
import type { TurnState } from "./turn-state.ts";

const LOG_FALLBACK = "The log scale needs values above zero, so this chart uses a linear scale.";
const STACK_LOG = "Stacked series are drawn on a linear scale.";
const BOUNDS_WIDENED =
  "The requested y-axis bounds would hide some values, so the chart shows the full range.";
/** Sources whose points are amounts per month, which can be summed; the others are levels. */
const FLOW_SOURCES: ReadonlySet<string> = new Set(["spending-by-month"]);

type Shown = ResolvedSeries & { readonly axis: "left" | "right" };

/** Left-axis series must be in yUnit; right-axis ones in one unit of their own. */
const checkUnits = (series: readonly Shown[], yUnit: YUnit): void => {
  series.forEach((row, index) => {
    if (row.axis === "left" && row.unit !== yUnit) {
      throw new Error(
        `Series ${index + 1} (${row.label}) is in ${row.unit}, but the chart's unit is ${yUnit}. Put it on axis "right" or change yUnit`,
      );
    }
  });
  const right = new Set(series.filter((row) => row.axis === "right").map((row) => row.unit));
  if (right.size > 1) {
    throw new Error(`The right axis holds one unit; these series are in ${[...right].join(", ")}`);
  }
};

const scaleOf = (
  spec: ChartSpec,
  series: readonly Shown[],
  band: ChartData["band"],
): Pick<ChartData, "yScale" | "notes"> => {
  if (spec.yScale !== "log") return { yScale: "linear", notes: [] };
  if (spec.kind === "stacked-bar" || spec.series.some((row) => row.stack !== undefined)) {
    return { yScale: "linear", notes: [STACK_LOG] };
  }
  const left = series.filter((row) => row.axis === "left").flatMap((row) => row.points);
  const positive =
    left.every((point) => point.y > 0) && (band?.points ?? []).every((point) => point.low > 0);
  return positive ? { yScale: "log", notes: [] } : { yScale: "linear", notes: [LOG_FALLBACK] };
};

/** Refusals that need no data: what a transform or band may apply to, and what may share an axis. */
const checkRefs = (spec: ChartSpec): void => {
  spec.series.forEach((ref, index) => {
    if (ref.transform === "cumulative" && !FLOW_SOURCES.has(ref.source)) {
      throw new Error(
        `Series ${index + 1}: cumulative sums amounts per month, so it is only for spending-by-month; ${ref.source} is already a level`,
      );
    }
  });
  const categories = spec.series.filter((ref) => ref.source === "allocation").length;
  if (categories > 0 && categories < spec.series.length) {
    throw new Error("Allocation is by category, not time; chart it apart from time series");
  }
  if (spec.band !== undefined) {
    if (spec.yUnit !== "EUR") throw new Error("A forecast band is in euros: use yUnit EUR");
    if (spec.series.some((ref) => (ref.transform ?? "none") !== "none")) {
      throw new Error(
        "A band is drawn in plain euros, so it cannot share a chart with a transformed series",
      );
    }
  }
};

const transformed = (
  row: ResolvedSeries,
  transform: Transform,
  axis: "left" | "right" | undefined,
) => {
  const out = applyTransform(row.points, transform);
  const label = `${row.label}${TRANSFORM_SUFFIX[out.applied]}`;
  const series: Shown = {
    label,
    unit: transformedUnit(row.unit, out.applied),
    points: thin(out.points),
    axis: axis ?? "left",
  };
  return { series, note: out.note === null ? null : `${row.label} ${out.note}.` };
};

type Bounded = { readonly spec: ChartSpec; readonly note: string | null };

/** Bounds may widen the y axis but never hide a value: bounds that would are dropped, with a note. */
const withinBounds = (
  spec: ChartSpec,
  series: readonly Shown[],
  band: ChartData["band"],
): Bounded => {
  if (spec.yMin === undefined && spec.yMax === undefined) return { spec, note: null };
  const values = [
    ...series.filter((row) => row.axis === "left").flatMap((row) => row.points.map((p) => p.y)),
    ...(band?.points ?? []).flatMap((point) => [point.low, point.high]),
  ];
  const hidden = values.some(
    (value) =>
      (spec.yMin !== undefined && value < spec.yMin) ||
      (spec.yMax !== undefined && value > spec.yMax),
  );
  return hidden
    ? { spec: { ...spec, yMin: undefined, yMax: undefined }, note: BOUNDS_WIDENED }
    : { spec, note: null };
};

export const buildChartTool = (db: Db, userId: string, turn: TurnState): ChartTool => ({
  name: "show_chart",
  description:
    "Shows the owner a chart of data the app computes; you never pass numbers, only references. " +
    "You control how it looks, so be creative: pick kinds, colours, axes and annotations that make the point clear. " +
    `series (1-${MAX_CHART_SERIES}), each a source plus optional style: ` +
    '{source:"forecast", scenarioId (from run_forecast in this answer), path: expected|low|high|contributed, holdingId?}, ' +
    '{source:"value-series", range}, {source:"spending-by-month", categoryId? (e.g. groceries; none = all spending), months 1-120}, ' +
    '{source:"holding-price", instrumentId, range} (prices in euros), {source:"allocation", dimension: kind|currency|account|instrument} ' +
    "(EUR values, or % weights when yUnit is %). range: 3m, 6m, 1y, 3y, 5y, 10y or max. " +
    "Series style: kind line|area|bar|scatter|step (mix them in one chart), label (legend, ≤60), " +
    "color (palette slot 1-8 or a hex like #e34948), width 1-6, dash solid|dashed|dotted, opacity 0.1-1, " +
    "fillOpacity 0-1, curve linear|smooth|step, points (markers), axis left|right (right for a second unit), " +
    "stack (series sharing an id stack), transform none|cumulative|percent-change-from-start|index-100 " +
    "(the app computes it; cumulative only for spending-by-month; percent change is in %, index-100 in index). " +
    "yMin/yMax may widen the axis but never hide a value. Allocation cannot share a chart with time series. " +
    "Chart: title (≤120), subtitle, kind (default series kind: line|bar|area|stacked-bar), yUnit of the left axis " +
    "(EUR, %, count or index; must match its series), yScale linear|log, yMin, yMax, yFormat EUR|compact-EUR|%|number, " +
    "xLabel, yLabel (≤40), grid, legend top|bottom|none, height 200-520, band {scenarioId, holdingId?, label?, color?, fillOpacity?} " +
    "(shades a scenario's low-high range; yUnit EUR, no transformed series), annotations (≤10): {type:y-line, y, label, axis?, color?}, " +
    "{type:x-line, x: YYYY-MM or YYYY-MM-DD, label, color?}, {type:x-range, from, to, label, color?} (labels ≤40), " +
    "note (≤300, shown as the assistant's note). You get back each series' first and last point, not the data. " +
    "At most ten charts per answer.",
  schema: ChartSpecSchema,
  chart: async (input) => {
    const parsed = ChartSpecSchema.parse(input);
    checkRefs(parsed);
    const on = today();
    const resolved = await Promise.all(
      parsed.series.map((ref) => resolveSeries(db, userId, turn, ref, parsed.yUnit, on)),
    );
    const shown = resolved.map((row, index) =>
      transformed(row, parsed.series[index]?.transform ?? "none", parsed.series[index]?.axis),
    );
    const series = shown.map((row) => row.series);
    checkUnits(series, parsed.yUnit);
    const band = parsed.band === undefined ? undefined : forecastBand(turn, parsed.band);
    const { spec, note: boundsNote } = withinBounds(parsed, series, band);
    const scale = scaleOf(spec, series, band);
    turn.claimChart();
    return ChatChartSchema.parse({
      chartId: crypto.randomUUID(),
      spec,
      data: {
        series: series.map((row) => ({ label: row.label, unit: row.unit, points: row.points })),
        band,
        yScale: scale.yScale,
        notes: [
          ...shown.flatMap((row) => (row.note === null ? [] : [row.note])),
          ...(boundsNote === null ? [] : [boundsNote]),
          ...scale.notes,
        ],
      },
    });
  },
});
