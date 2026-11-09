import { z } from "zod";

// No server-only imports: the chat page validates streamed and stored charts with this.

export const MAX_CHART_SERIES = 6;
export const MAX_CHART_POINTS = 400;
export const MAX_CHARTS_PER_TURN = 10;
export const MAX_TITLE = 120;
export const MAX_NOTE = 300;

export const CHART_RANGES = ["3m", "6m", "1y", "3y", "5y", "10y", "max"] as const;
const Range = z.enum(CHART_RANGES);

/** Names data the app produces; there is deliberately no field for values. */
export const SeriesRefSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("forecast"),
      scenarioId: z.string().min(1).max(20),
      path: z.enum(["expected", "low", "high", "contributed"]),
      holdingId: z.number().int().positive().optional(),
    })
    .strict(),
  z.object({ source: z.literal("value-series"), range: Range }).strict(),
  z
    .object({
      source: z.literal("spending-by-month"),
      categoryId: z.string().min(1).max(40).optional(),
      months: z.number().int().min(1).max(120),
    })
    .strict(),
  z
    .object({
      source: z.literal("holding-price"),
      instrumentId: z.number().int().positive(),
      range: Range,
    })
    .strict(),
  z
    .object({
      source: z.literal("allocation"),
      dimension: z.enum(["kind", "currency", "account", "instrument"]),
    })
    .strict(),
]);

export type SeriesRef = z.infer<typeof SeriesRefSchema>;

export const CHART_KINDS = ["line", "bar", "area", "stacked-bar"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];
export const Y_UNITS = ["EUR", "%", "count"] as const;

/** What the model may send: a title, a kind and references. `title` and `note` are model text, shown as plain text only. */
export const ChartSpecSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE),
    kind: z.enum(CHART_KINDS),
    series: z.array(SeriesRefSchema).min(1).max(MAX_CHART_SERIES),
    yUnit: z.enum(Y_UNITS),
    note: z.string().trim().max(MAX_NOTE).optional(),
  })
  .strict();

export type ChartSpec = z.infer<typeof ChartSpecSchema>;

const Point = z.object({ x: z.string().min(1).max(200), y: z.number() }).strict();

/** Numbers the app computed for each reference, in the spec's order; labels are app-built. */
export const ChartDataSchema = z
  .object({
    series: z
      .array(
        z
          .object({
            label: z.string().min(1).max(200),
            points: z.array(Point).max(MAX_CHART_POINTS),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_CHART_SERIES),
  })
  .strict();

export type ChartData = z.infer<typeof ChartDataSchema>;

/** A chart as streamed and as stored with the conversation: it changes nothing, so a reload may show it again. */
export const ChatChartSchema = z
  .object({ chartId: z.string().min(1).max(64), spec: ChartSpecSchema, data: ChartDataSchema })
  .strict();

export type ChatChart = z.infer<typeof ChatChartSchema>;

/** What the model is told about a chart it asked for: counts and end points, never the series. */
export const chartSummary = (chart: ChatChart) => ({
  status: `Chart shown: ${chart.spec.title}`,
  chartId: chart.chartId,
  unit: chart.spec.yUnit,
  series: chart.data.series.map((series) => ({
    label: series.label,
    points: series.points.length,
    first: series.points[0] ?? null,
    last: series.points.at(-1) ?? null,
  })),
});
