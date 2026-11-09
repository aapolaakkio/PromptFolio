import {
  HexColorSchema,
  PaletteSlotSchema,
  type ChartData,
  type ChartSpec,
  type SeriesColor,
} from "../../server/chat/chart-schema.ts";
import { eur, formatDate } from "../lib/format.ts";
import { shortMonth } from "./CategoryTrendChart.tsx";
import { colourFor } from "./palette.ts";
import { compactEur } from "./TimeSeriesChart.tsx";

const TIME_X = /^\d{4}-\d{2}(-\d{2})?$/;

type At = { readonly at: number; readonly x: string; readonly y: number };

/** Every series on one shared x axis: dates and months sorted, category labels in the app's order. */
export const chatChartRows = (data: ChartData) => {
  const unique = [...new Set(data.series.flatMap((series) => series.points.map((p) => p.x)))];
  const xs = unique.every((x) => TIME_X.test(x)) ? unique.toSorted() : unique;
  const index = new Map(xs.map((x, at) => [x, at]));
  // Two references can resolve to the same label; the legend needs them apart.
  const labels = data.series.map((series, at) => {
    const before = data.series.slice(0, at).filter((other) => other.label === series.label).length;
    return before === 0 ? series.label : `${series.label} (${before + 1})`;
  });
  const rows: At[][] = data.series.map((series) =>
    series.points.map((point) => ({ at: index.get(point.x) ?? 0, x: point.x, y: point.y })),
  );
  return { xs, labels, rows, index };
};

/** Series sharing a stack id sit on the ones before them, x by x; a series without one starts at zero. */
export const stackedRows = (
  series: readonly (readonly { readonly at: number; readonly y: number }[])[],
  stacks: readonly (string | undefined)[],
) =>
  series.reduce<{
    readonly out: { at: number; y1: number; y2: number }[][];
    readonly tops: ReadonlyMap<string, ReadonlyMap<number, number>>;
  }>(
    ({ out, tops }, rows, index) => {
      const id = stacks[index];
      const top = new Map<number, number>(id === undefined ? [] : (tops.get(id) ?? []));
      const stacked = rows.map((row) => {
        const y1 = top.get(row.at) ?? 0;
        return { at: row.at, y1, y2: y1 + row.y };
      });
      const next =
        id === undefined
          ? tops
          : new Map<string, ReadonlyMap<number, number>>([
              ...tops,
              [id, new Map([...top, ...stacked.map((row): [number, number] => [row.at, row.y2])])],
            ]);
      return { out: [...out, stacked], tops: next };
    },
    { out: [], tops: new Map() },
  ).out;

/** A palette slot or a hex, re-checked here because it lands in an SVG attribute; anything else is the series' own slot. */
export const colourOf = (color: SeriesColor | undefined, index: number): string => {
  const slot = PaletteSlotSchema.safeParse(color);
  if (slot.success) return colourFor(slot.data - 1);
  const hex = HexColorSchema.safeParse(color);
  return hex.success ? hex.data : colourFor(index);
};

export const xText = (x: string): string =>
  /^\d{4}-\d{2}$/.test(x) ? shortMonth(x) : TIME_X.test(x) ? formatDate(x) : x;

type Format = NonNullable<ChartSpec["yFormat"]>;

const FORMATS = {
  EUR: (value: number) => eur(String(value)),
  "compact-EUR": compactEur,
  "%": (value: number) => `${Math.round(value * 100) / 100} %`,
  number: (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: 2 }),
} satisfies Record<Format, (value: number) => string>;

const UNIT_FORMAT = {
  EUR: "compact-EUR",
  "%": "%",
  count: "number",
  index: "number",
} as const satisfies Record<ChartSpec["yUnit"], Format>;

export const formatFor = (format: Format | undefined, unit: ChartSpec["yUnit"]) =>
  FORMATS[format ?? UNIT_FORMAT[unit]];

/** Tooltips show the exact euros even when the axis is compact. */
export const tipFormatFor = (format: Format | undefined, unit: ChartSpec["yUnit"]) =>
  (format ?? UNIT_FORMAT[unit]) === "compact-EUR" ? FORMATS.EUR : formatFor(format, unit);

export const DASH = { solid: undefined, dashed: "6 4", dotted: "2 3" } as const;

/** Where a date or month falls on the shared index axis: the first x at or after it. */
export const positionOf = (xs: readonly string[], x: string): number => {
  const found = xs.findIndex((candidate) => candidate >= x);
  return found === -1 ? Math.max(0, xs.length - 1) : found;
};
