import { z } from "zod";

// No server-only imports: the chat page validates streamed and stored charts with this.

export const MAX_CHART_SERIES = 6;
export const MAX_CHART_POINTS = 400;
export const MAX_CHARTS_PER_TURN = 10;
export const MAX_TITLE = 120;
export const MAX_NOTE = 300;

export const CHART_RANGES = ["3m", "6m", "1y", "3y", "5y", "10y", "max"] as const;
const Range = z.enum(CHART_RANGES);

const plain = (max: number) => z.string().trim().min(1).max(max);

// Checked again on the page before a colour reaches an SVG attribute: a slot 1-8 or a hex code, nothing else.
const HEX = /^#[0-9a-fA-F]{3,8}$/;
export const PaletteSlotSchema = z.number().int().min(1).max(8);
export const HexColorSchema = z
  .string()
  .regex(HEX, "A colour is a palette slot 1-8 or a hex code like #2a78d6");
export const SeriesColorSchema = z.union([PaletteSlotSchema, HexColorSchema]);
export type SeriesColor = z.infer<typeof SeriesColorSchema>;

export const SERIES_KINDS = ["line", "area", "bar", "scatter", "step"] as const;
export const TRANSFORMS = ["none", "cumulative", "percent-change-from-start", "index-100"] as const;

/** How a series looks, never what it holds. */
const style = {
  kind: z.enum(SERIES_KINDS).optional(),
  label: plain(60).optional(),
  color: SeriesColorSchema.optional(),
  width: z.number().min(1).max(6).optional(),
  dash: z.enum(["solid", "dashed", "dotted"]).optional(),
  opacity: z.number().min(0.1).max(1).optional(),
  fillOpacity: z.number().min(0).max(1).optional(),
  curve: z.enum(["linear", "smooth", "step"]).optional(),
  points: z.boolean().optional(),
  axis: z.enum(["left", "right"]).optional(),
  stack: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,20}$/, "A stack id is 1-20 letters, digits, - or _")
    .optional(),
  transform: z.enum(TRANSFORMS).optional(),
};

/** Names data the app produces, plus its look; there is deliberately no field for values. */
export const SeriesRefSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("forecast"),
      scenarioId: z.string().min(1).max(20),
      path: z.enum(["expected", "low", "high", "contributed"]),
      holdingId: z.number().int().positive().optional(),
      ...style,
    })
    .strict(),
  z.object({ source: z.literal("value-series"), range: Range, ...style }).strict(),
  z
    .object({
      source: z.literal("spending-by-month"),
      categoryId: z.string().min(1).max(40).optional(),
      months: z.number().int().min(1).max(120),
      ...style,
    })
    .strict(),
  z
    .object({
      source: z.literal("holding-price"),
      instrumentId: z.number().int().positive(),
      range: Range,
      ...style,
    })
    .strict(),
  z
    .object({
      source: z.literal("allocation"),
      dimension: z.enum(["kind", "currency", "account", "instrument"]),
      ...style,
    })
    .strict(),
]);

export type SeriesRef = z.infer<typeof SeriesRefSchema>;

const XValue = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, "An x value is YYYY-MM or YYYY-MM-DD");
export const MAX_ANNOTATIONS = 10;

/** Placed by the app at validated values; the label is the model's own words, drawn as an annotation. */
export const AnnotationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("y-line"),
      y: z.number(),
      label: plain(40),
      axis: z.enum(["left", "right"]).optional(),
      color: SeriesColorSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("x-line"),
      x: XValue,
      label: plain(40),
      color: SeriesColorSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("x-range"),
      from: XValue,
      to: XValue,
      label: plain(40),
      color: SeriesColorSchema.optional(),
    })
    .strict(),
]);

export type Annotation = z.infer<typeof AnnotationSchema>;

export const CHART_KINDS = ["line", "bar", "area", "stacked-bar"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];
export const Y_UNITS = ["EUR", "%", "count", "index"] as const;
export type YUnit = (typeof Y_UNITS)[number];

/** What the model may send: references and how they look. Every text field is model text, shown as plain text only. */
export const ChartSpecSchema = z
  .object({
    title: plain(MAX_TITLE),
    subtitle: plain(MAX_TITLE).optional(),
    kind: z.enum(CHART_KINDS).optional(),
    series: z.array(SeriesRefSchema).min(1).max(MAX_CHART_SERIES),
    yUnit: z.enum(Y_UNITS),
    yScale: z.enum(["linear", "log"]).optional(),
    yMin: z.number().optional(),
    yMax: z.number().optional(),
    yFormat: z.enum(["EUR", "compact-EUR", "%", "number"]).optional(),
    xLabel: plain(40).optional(),
    yLabel: plain(40).optional(),
    grid: z.boolean().optional(),
    legend: z.enum(["top", "bottom", "none"]).optional(),
    height: z.number().int().min(200).max(520).optional(),
    band: z
      .object({
        scenarioId: z.string().min(1).max(20),
        holdingId: z.number().int().positive().optional(),
        label: plain(60).optional(),
        color: SeriesColorSchema.optional(),
        fillOpacity: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
    annotations: z.array(AnnotationSchema).max(MAX_ANNOTATIONS).optional(),
    note: z.string().trim().max(MAX_NOTE).optional(),
  })
  .strict()
  .refine((spec) => spec.yMin === undefined || spec.yMax === undefined || spec.yMin < spec.yMax, {
    message: "yMin must be below yMax",
    path: ["yMin"],
  });

export type ChartSpec = z.infer<typeof ChartSpecSchema>;

const Point = z
  .object({
    x: z.string().min(1).max(200),
    y: z.number(),
    /** A stale price or a holding valued at cost that day: drawn dashed, as on the dashboard. */
    estimated: z.boolean().optional(),
  })
  .strict();

/** Numbers the app computed for each reference, in the spec's order; labels and notes are app-built. */
export const ChartDataSchema = z
  .object({
    series: z
      .array(
        z
          .object({
            label: z.string().min(1).max(200),
            unit: z.enum(Y_UNITS),
            points: z.array(Point).max(MAX_CHART_POINTS),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_CHART_SERIES),
    band: z
      .object({
        label: z.string().min(1).max(200),
        points: z
          .array(
            z.object({ x: z.string().min(1).max(200), low: z.number(), high: z.number() }).strict(),
          )
          .max(MAX_CHART_POINTS),
      })
      .strict()
      .optional(),
    /** The scale actually drawn: a log scale falls back to linear when a value is not positive. */
    yScale: z.enum(["linear", "log"]),
    notes: z.array(z.string().min(1).max(300)).max(10),
  })
  .strict();

export type ChartData = z.infer<typeof ChartDataSchema>;

/** A chart as streamed and as stored with the conversation: it changes nothing, so a reload may show it again. */
export const ChatChartSchema = z
  .object({ chartId: z.string().min(1).max(64), spec: ChartSpecSchema, data: ChartDataSchema })
  .strict();

export type ChatChart = z.infer<typeof ChatChartSchema>;

/** An old chart past the per-conversation cap: its spec stays, its numbers are dropped. */
export const ExpiredChartSchema = z
  .object({ chartId: z.string().min(1).max(64), spec: ChartSpecSchema, expired: z.literal(true) })
  .strict();

export const StoredChartSchema = z.union([ChatChartSchema, ExpiredChartSchema]);

/** What the model is told about a chart it asked for: counts and end points, never the series. */
export const chartSummary = (chart: ChatChart) => ({
  status: `Chart shown: ${chart.spec.title}`,
  chartId: chart.chartId,
  unit: chart.spec.yUnit,
  scale: chart.data.yScale,
  notes: chart.data.notes,
  series: chart.data.series.map((series) => ({
    label: series.label,
    unit: series.unit,
    points: series.points.length,
    // Said out loud so an answer does not present an estimated stretch as market value.
    estimatedPoints: series.points.filter((point) => point.estimated === true).length,
    first: series.points[0] ?? null,
    last: series.points.at(-1) ?? null,
  })),
});
