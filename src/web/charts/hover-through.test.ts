import { expect, test } from "vitest";

import { hoverTarget } from "./hover-through.ts";

type Surface = { readonly name: string };
const SURFACE: Surface = { name: "chart" };

const node = (inBrush: boolean, surface: Surface | null) => ({
  closest: (selector: string) =>
    inBrush && selector === "[data-chart-brush]"
      ? { parentElement: { querySelector: () => surface } }
      : null,
});

test("a hover over the zoom layer is sent to the chart under it", () => {
  expect(hoverTarget({ buttons: 0, target: node(true, SURFACE) })).toBe(SURFACE);
});

test("a drag is left to the zoom layer", () => {
  expect(hoverTarget({ buttons: 1, target: node(true, SURFACE) })).toBeNull();
});

test("a hover over the chart itself needs no help", () => {
  expect(hoverTarget({ buttons: 0, target: node(false, SURFACE) })).toBeNull();
});
