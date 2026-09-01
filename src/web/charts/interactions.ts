/**
 * The focus behaviour a chart over time wants.
 *
 * `nearest-x` with an infinite reach, so the crosshair follows the pointer
 * across empty plot rather than dropping inspection between sparse points --
 * a value series with one point a day has plenty of empty vertical space, and
 * a tooltip that vanishes when the pointer strays off the line reads as broken.
 */
export const TIME_FOCUS = {
  focus: "nearest-x",
  maxFocusDistance: Number.POSITIVE_INFINITY,
} as const;

/**
 * The focus behaviour a chart of discrete things wants: one mark, its own
 * tooltip, and inspection cleared when the pointer leaves it. A finite reach is
 * the default, and the right one here -- hovering the gap between two bars
 * should show nothing, not the nearest bar.
 */
export const MARK_FOCUS = { focus: "nearest" } as const;
