/** `nearest-x` with infinite reach: the crosshair follows the pointer across empty plot between sparse points. */
export const TIME_FOCUS = {
  focus: "nearest-x",
  maxFocusDistance: Number.POSITIVE_INFINITY,
} as const;

/** One mark with its own tooltip, cleared when the pointer leaves; finite reach so the gap between bars shows nothing. */
export const MARK_FOCUS = { focus: "nearest" } as const;

/** Every series at the pointer's x, wherever the pointer is in the plot: one tooltip for the whole month. */
export const GROUP_FOCUS = {
  focus: "group-x",
  maxFocusDistance: Number.POSITIVE_INFINITY,
} as const;
