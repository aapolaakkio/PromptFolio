import { test, expect } from "vitest";

import { colourFor, SERIES_COUNT, SERIES_DARK, SERIES_LIGHT } from "./palette.ts";

import { readFile } from "node:fs/promises";

const readFileText = (path: string | URL): Promise<string> => readFile(path, "utf-8");

test("the palette has enough distinct colours for a realistic portfolio", () => {
  expect(SERIES_LIGHT.length).toBeGreaterThanOrEqual(8);
  expect(new Set(SERIES_LIGHT).size).toBe(SERIES_LIGHT.length);
  expect(new Set(SERIES_DARK).size).toBe(SERIES_DARK.length);
});

test("both themes define the same number of slots", () => {
  expect(SERIES_DARK.length).toBe(SERIES_LIGHT.length);
});

test("every recorded colour is a hex value", () => {
  for (const colour of [...SERIES_LIGHT, ...SERIES_DARK]) {
    expect(colour).toMatch(/^#[0-9a-f]{6}$/i);
  }
});

test("colours are referenced through the theme, so dark mode needs no branch", () => {
  expect(colourFor(0)).toBe("var(--series-1)");
  expect(colourFor(SERIES_COUNT)).toBe("var(--series-1)");
  expect(colourFor(SERIES_COUNT + 3)).toBe("var(--series-4)");
});

test("the stylesheet defines every slot this module promises, in both themes", async () => {
  // Values live in CSS, the count here: stops the two drifting apart.
  const css = await readFileText("src/web/styles.css");
  for (let slot = 1; slot <= SERIES_COUNT; slot++) {
    expect(css.match(new RegExp(`--series-${slot}:`, "g"))?.length).toBe(2);
  }
});
