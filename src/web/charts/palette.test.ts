import { test, expect } from "bun:test";
import { SERIES_COLOURS, colourFor } from "./palette";

test("the palette has enough distinct colours for a realistic portfolio", () => {
  expect(SERIES_COLOURS.length).toBeGreaterThanOrEqual(8);
  expect(new Set(SERIES_COLOURS).size).toBe(SERIES_COLOURS.length);
});

test("colours cycle rather than running off the end", () => {
  expect(colourFor(0)).toBe(SERIES_COLOURS[0]);
  expect(colourFor(SERIES_COLOURS.length)).toBe(SERIES_COLOURS[0]);
  expect(colourFor(SERIES_COLOURS.length + 3)).toBe(SERIES_COLOURS[3]);
});

test("every colour is a hex value", () => {
  for (const colour of SERIES_COLOURS) expect(colour).toMatch(/^#[0-9a-f]{6}$/i);
});
