import type { SeriesRef, YUnit } from "./chart-schema.ts";

type Point = { readonly x: string; readonly y: number };
type Transform = NonNullable<SeriesRef["transform"]>;

const round = (value: number): number => Math.round(value * 10_000) / 10_000;

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

/** The app does the arithmetic, so "growth indexed to 100" never needs the model to calculate. */
export const applyTransform = (points: readonly Point[], transform: Transform): Point[] => {
  if (transform === "none") return [...points];
  if (transform === "cumulative") {
    return points.reduce<Point[]>(
      (acc, point) => [...acc, { x: point.x, y: round((acc.at(-1)?.y ?? 0) + point.y) }],
      [],
    );
  }
  const start = points[0]?.y;
  if (start === undefined) return [];
  if (start === 0)
    throw new Error("A series that starts at zero cannot be measured from its start");
  return points.map((point) => ({
    x: point.x,
    y: round(transform === "index-100" ? (point.y / start) * 100 : (point.y / start - 1) * 100),
  }));
};
