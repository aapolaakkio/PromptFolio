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
const MONTH = /^\d{4}-\d{2}$/;
const DAY_MS = 86_400_000;

/** A month sits at its first day, a day at its own: both on one real time line. */
const millisOf = (x: string): number =>
  Date.parse(MONTH.test(x) ? `${x}-01T00:00:00Z` : `${x}T00:00:00Z`);

type At = {
  readonly at: number;
  readonly x: string;
  readonly y: number;
  readonly estimated: boolean;
};

/**
 * Every series on one shared x axis. Dates and months are placed in real time, so a year of days
 * beside ten years of months takes a tenth of the width; category labels keep the app's order.
 */
export const chatChartRows = (data: ChartData) => {
  const all = [
    ...data.series.flatMap((series) => series.points.map((point) => point.x)),
    ...(data.band?.points ?? []).map((point) => point.x),
  ];
  const unique = [...new Set(all)];
  const time = unique.length > 0 && unique.every((x) => TIME_X.test(x));
  const xs = time ? unique.toSorted() : unique;
  const index = new Map(xs.map((x, at) => [x, at]));
  const atOf = (x: string): number => (time ? millisOf(x) : (index.get(x) ?? 0));
  // Two references can resolve to the same label; the tooltip and legend need them apart.
  const labels = data.series.map((series, at) => {
    const before = data.series.slice(0, at).filter((other) => other.label === series.label).length;
    return before === 0 ? series.label : `${series.label} (${before + 1})`;
  });
  const rows: At[][] = data.series.map((series) =>
    series.points.map((point) => ({
      at: atOf(point.x),
      x: point.x,
      y: point.y,
      estimated: point.estimated === true,
    })),
  );
  const ats = xs.map(atOf);
  const gaps = ats.slice(1).map((at, i) => at - (ats[i] ?? at));
  // One bar slot: the narrowest gap between neighbours, a month when there is only one point.
  const slot = time ? Math.min(...gaps.filter((gap) => gap > 0), 30 * DAY_MS) : 1;
  const months = time && xs.every((x) => MONTH.test(x));
  return { time, months, xs, labels, rows, atOf, slot, first: ats[0] ?? 0, last: ats.at(-1) ?? 1 };
};

export type ChartRows = ReturnType<typeof chatChartRows>;

/** The text for a point on the x axis: a month, a day or a category. */
export const atText = (rows: ChartRows, at: number): string => {
  if (!rows.time) return rows.xs[Math.round(at)] ?? "";
  const iso = new Date(at).toISOString();
  return rows.months ? shortMonth(iso.slice(0, 7)) : formatDate(iso.slice(0, 10));
};

/** The floor a log axis draws from: yMin when it is positive, else half the smallest positive value. */
export const logFloor = (values: readonly number[], yMin: number | undefined): number => {
  if (yMin !== undefined && yMin > 0) return yMin;
  const positive = values.filter((value) => value > 0);
  return positive.length === 0 ? 1 : Math.min(...positive) / 2;
};

/** Annotation labels are the model's words: one muted colour for all, never a series colour. */
export const NOTE_COLOUR = "var(--color-muted)";
export const NOTE_MARK = "✎";

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
