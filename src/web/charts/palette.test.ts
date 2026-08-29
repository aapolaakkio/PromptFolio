import { test, expect } from "bun:test";

import { colourFor, needsGrouping, SERIES_COUNT, SERIES_DARK, SERIES_LIGHT } from "./palette";

test("the palette has enough distinct colours for a realistic portfolio", () => {
  expect(SERIES_LIGHT.length).toBeGreaterThanOrEqual(8);
  expect(new Set(SERIES_LIGHT).size).toBe(SERIES_LIGHT.length);
  expect(new Set(SERIES_DARK).size).toBe(SERIES_DARK.length);
});

test("both themes define the same number of slots", () => {
  // A chart asks for slot N and gets whichever theme is active; a missing slot
  // in one theme would render an unstyled mark rather than a colour.
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
  // The values live in CSS and the count lives here; this is what stops the two
  // drifting apart and a chart asking for a variable nobody defined.
  const css = await Bun.file("src/web/styles.css").text();
  for (let slot = 1; slot <= SERIES_COUNT; slot++) {
    expect(css.match(new RegExp(`--series-${slot}:`, "g"))?.length).toBe(2);
  }
});

test("says when there are too many series for colour to carry identity", () => {
  // Beyond eight a reader cannot hold the hues apart, and a generated ninth is
  // never as separable as the validated eight.
  expect(needsGrouping(SERIES_COUNT)).toBe(false);
  expect(needsGrouping(SERIES_COUNT + 1)).toBe(true);
});
