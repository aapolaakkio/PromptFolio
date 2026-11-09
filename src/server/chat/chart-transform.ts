import { MAX_CHART_POINTS, type SeriesRef, type YUnit } from "./chart-schema.ts";

type Point = { readonly x: string; readonly y: number };
export type Transform = NonNullable<SeriesRef["transform"]>;

const round = (value: number): number => Math.round(value * 10_000) / 10_000;

/** Evenly thinned, keeping the last point, so the shape survives the cap. Runs after any transform. */
export const thin = <T>(points: readonly T[]): T[] => {
  const step = Math.max(1, Math.ceil(points.length / MAX_CHART_POINTS));
  return points.filter((_, index) => index % step === 0 || index === points.length - 1);
};

/** The unit a transform turns a series into. */
export const transformedUnit = (unit: YUnit, transform: Transform): YUnit => {
  switch (transform) {
    case "none":
    case "cumulative":
      return unit;
    case "percent-change-from-start":
      return "%";
    case "index-100":
      return "index";
  }
};

/** Appended to the app's label, so a tooltip always says what the line is. */
export const TRANSFORM_SUFFIX = {
  none: "",
  cumulative: ", cumulative",
  "percent-change-from-start": ", % change from start",
  "index-100": ", indexed to 100",
} as const satisfies Record<Transform, string>;

type Transformed<T extends Point> = {
  readonly points: T[];
  readonly applied: Transform;
  readonly note: string | null;
};

/** The app does the arithmetic. A change from a start at or below zero has no meaning, so that series is shown as is, with a note. */
export const applyTransform = <T extends Point>(
  points: readonly T[],
  transform: Transform,
): Transformed<T> => {
  if (transform === "none") return { points: [...points], applied: "none", note: null };
  if (transform === "cumulative") {
    const sums = points.reduce<T[]>(
      (acc, point) => [...acc, { ...point, y: round((acc.at(-1)?.y ?? 0) + point.y) }],
      [],
    );
    return { points: sums, applied: "cumulative", note: null };
  }
  const start = points[0]?.y;
  if (start === undefined) return { points: [], applied: transform, note: null };
  if (start <= 0) {
    return {
      points: [...points],
      applied: "none",
      note: "starts at or below zero, so it is shown without the change from start",
    };
  }
  return {
    points: points.map((point) => ({
      ...point,
      y: round(transform === "index-100" ? (point.y / start) * 100 : (point.y / start - 1) * 100),
    })),
    applied: transform,
    note: null,
  };
};
