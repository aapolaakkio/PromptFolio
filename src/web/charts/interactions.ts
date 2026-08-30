import { eur, fiDate } from "../lib/format.ts";

/**
 * How every chart in this app formats a hovered value.
 *
 * Shared so a figure in a tooltip reads exactly as the same figure in a table:
 * two formatting paths for one number is two chances to disagree, and the one
 * under the cursor is the one a person acts on.
 *
 * The value arrives as the decimal string the API returned -- never a float
 * this layer parsed and re-rendered.
 */
export const moneyTip = (label: string, valueEur: string): string => `${label}: ${eur(valueEur)}`;

/** A date tooltip, in the same Finnish form the tables use. */
export const dateTip = (iso: string): string => fiDate(iso);

/** A percentage tooltip, from a ratio, matching `share()`'s one decimal. */
export const shareTip = (label: string, ratio: number): string =>
  `${label}: ${(ratio * 100).toFixed(1).replace(".", ",")} %`;

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
