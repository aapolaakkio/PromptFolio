/**
 * Chart series colours.
 *
 * The values live in `styles.css` as `--series-1` … `--series-8`, once per
 * theme, and are referenced here rather than duplicated: a chart mark takes a
 * CSS variable in `fill`/`stroke` exactly as a hex, so dark mode needs no
 * branch in any chart. `palette.test.ts` asserts the stylesheet and this file
 * still agree about how many slots exist.
 *
 * The hexes below are recorded for the validator and for tests, and are the
 * ones that were checked: every adjacent pair clears the colour-vision and
 * normal-vision separation floors against both this app's surfaces.
 */
export const SERIES_LIGHT = [
  "#2a78d6",
  "#eb6834",
  "#1baf7a",
  "#eda100",
  "#e87ba4",
  "#008300",
  "#4a3aa7",
  "#e34948",
] as const;

export const SERIES_DARK = [
  "#3987e5",
  "#d95926",
  "#199e70",
  "#c98500",
  "#d55181",
  "#008300",
  "#9085e9",
  "#e66767",
] as const;

export const SERIES_COUNT = SERIES_LIGHT.length;

/**
 * The colour for series `index`, as a CSS variable reference.
 *
 * Assigned in fixed order and never re-assigned when a series disappears: a
 * filter that removes one holding must not repaint the others, or the reader
 * has to re-learn the chart every time they change the date range.
 */
export const colourFor = (index: number): string => `var(--series-${(index % SERIES_COUNT) + 1})`;

/**
 * A ninth series does not get an invented ninth hue.
 *
 * Beyond eight, colour stops carrying identity -- the reader cannot hold nine
 * hues apart, and a generated one is never as separable as the validated eight.
 * Callers group the tail into one "Muu" series instead; this says where that
 * line falls so they do not have to guess.
 */
export const needsGrouping = (seriesCount: number): boolean => seriesCount > SERIES_COUNT;
