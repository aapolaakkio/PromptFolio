/**
 * A horizontal bump: the S-shaped curve a Sankey's ribbons are drawn with.
 *
 * Each segment leaves its start horizontally and arrives horizontally, bending
 * in between, which is what makes a flow diagram readable -- a straight
 * diagonal between two stacked columns crosses its neighbours at angles the eye
 * has to untangle.
 *
 * Written out rather than pulled from `d3-shape`: it is one cubic per segment
 * with both control points on the midpoint's x, and the chart library takes a
 * plain `{ line, area }` pair.
 */
export type Curve = {
  readonly line: (points: readonly (readonly [number, number])[]) => string;
  readonly area: (
    top: readonly (readonly [number, number])[],
    bottom: readonly (readonly [number, number])[],
  ) => string;
};

const round = (value: number): string => (Math.round(value * 100) / 100).toString();

/** `M`, then one cubic per gap, with the control points halfway across. */
const bumpPath = (points: readonly (readonly [number, number])[]): string => {
  const first = points[0];
  if (!first) return "";

  let path = `M${round(first[0])},${round(first[1])}`;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current) continue;
    const midpoint = (previous[0] + current[0]) / 2;
    path += `C${round(midpoint)},${round(previous[1])} ${round(midpoint)},${round(current[1])} ${round(current[0])},${round(current[1])}`;
  }
  return path;
};

export const bumpX: Curve = {
  line: bumpPath,
  area: (top, bottom) => {
    const upper = bumpPath(top);
    if (upper === "") return "";
    // The lower edge is walked back the way it came, so the ribbon closes on
    // itself instead of crossing through its own middle.
    const reversed = [...bottom].reverse();
    const lower = bumpPath(reversed);
    return `${upper}L${lower.slice(1)}Z`;
  },
};
