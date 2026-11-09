import { ChartSpecSchema, ChatChartSchema, MAX_CHART_SERIES } from "./chart-schema.ts";
import { resolveSeries } from "./chart-series.ts";
import { type ChartTool, type Db, today } from "./tool-types.ts";
import type { TurnState } from "./turn-state.ts";

export const buildChartTool = (db: Db, userId: string, turn: TurnState): ChartTool => ({
  name: "show_chart",
  description:
    "Shows the owner a chart of data the app computes; you never pass numbers. kind: line, bar, area " +
    "or stacked-bar. yUnit: EUR or % (count is accepted but no source produces it). title (≤120) and " +
    `note (≤300) are plain text. series (1-${MAX_CHART_SERIES}): ` +
    '{source:"forecast", scenarioId (from run_forecast in this answer), path: expected|low|high|contributed, holdingId?}, ' +
    '{source:"value-series", range}, {source:"spending-by-month", categoryId? (e.g. groceries; none = all spending), months 1-120}, ' +
    '{source:"holding-price", instrumentId, range} (prices in euros), {source:"allocation", dimension: kind|currency|account|instrument} ' +
    "(yUnit % for weights, EUR for values). range: 3m, 6m, 1y, 3y, 5y, 10y or max. " +
    "You get back each series' first and last point, not the data. At most ten charts per answer.",
  schema: ChartSpecSchema,
  chart: async (input) => {
    const spec = ChartSpecSchema.parse(input);
    const on = today();
    const series = await Promise.all(
      spec.series.map((ref) => resolveSeries(db, userId, turn, ref, spec.yUnit, on)),
    );
    const mismatch = series.findIndex((row) => row.unit !== spec.yUnit);
    if (mismatch >= 0) {
      const row = series[mismatch];
      throw new Error(
        `Series ${mismatch + 1} (${row?.label ?? ""}) is in ${row?.unit ?? "?"}, but the chart's unit is ${spec.yUnit}`,
      );
    }
    turn.claimChart();
    return ChatChartSchema.parse({
      chartId: crypto.randomUUID(),
      spec,
      data: { series: series.map((row) => ({ label: row.label, points: row.points })) },
    });
  },
});
