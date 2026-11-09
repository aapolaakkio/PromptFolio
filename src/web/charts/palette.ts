/**
 * Series colours live in `styles.css` as `--series-1`…`--series-8` per theme and are referenced as CSS variables, so dark mode needs no branch.
 * The hexes below are the validated ones (adjacent pairs clear colour-vision separation on both surfaces); `palette.test.ts` checks the slot count.
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

/** Series `index` colour, in fixed order and never reassigned when a series disappears. */
export const colourFor = (index: number): string => `var(--series-${(index % SERIES_COUNT) + 1})`;
