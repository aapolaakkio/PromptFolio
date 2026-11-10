import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

const css = readFileSync("src/web/styles.css", "utf8");
const library = (path: string): string => readFileSync(`node_modules/@tanstack/${path}`, "utf8");

/** The `--color-*` declarations of the first block that starts with `opener`. */
const colourTokens = (opener: string): Record<string, string> => {
  const start = css.indexOf(opener);
  expect(start).toBeGreaterThan(-1);
  const block = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    Array.from(block.matchAll(/(--color-[a-z-]+):\s*([^;]+);/g), (match) => [match[1], match[2]]),
  );
};

describe("print colours", () => {
  const light = colourTokens("@theme {");
  const print = colourTokens(":root[data-print-chart] {");

  test("restate every light colour token, so none is left dark on paper", () => {
    expect(Object.keys(print).toSorted()).toEqual(Object.keys(light).toSorted());
  });

  test("equal the light theme, except the two backgrounds, which are paper white", () => {
    const paper = { "--color-bg": "#ffffff", "--color-surface": "#ffffff" };

    expect(print).toEqual({ ...light, ...paper });
  });
});

describe("print overlays", () => {
  test("are hidden where the library really puts them", () => {
    // React hands this element to the renderer as its mount container...
    const renderer = library("react-charts/dist/RendererChart.js");
    expect(renderer).toContain("ChartSurface, { ref: containerRef");
    expect(renderer).toContain('className: "ts-chart-surface"');
    // ...and each control appends its own <svg> to that container, beside the chart's.
    for (const control of ["brush", "cursor"]) {
      expect(library(`charts/dist/interaction-${control}.js`)).toContain("container.append(root)");
    }

    expect(css).toContain(".ts-chart-surface > svg:not(.ts-chart)");
  });
});
