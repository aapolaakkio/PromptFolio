/** Ordered so adjacent slices stay distinguishable, and readable on both themes. */
export const SERIES_COLOURS = [
  "#14484f",
  "#c77d3a",
  "#4a7c59",
  "#8a5a83",
  "#2f6690",
  "#a8562f",
  "#5c7a3a",
  "#6b5b95",
] as const;

export const colourFor = (index: number): string => SERIES_COLOURS[index % SERIES_COLOURS.length]!;
