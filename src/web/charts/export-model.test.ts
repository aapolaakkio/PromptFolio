import { describe, expect, test } from "vitest";

import { exportFileName, inlinePaint, legendRows, readLegend, slugOf } from "./export-model.ts";

describe("slugOf", () => {
  test("turns spaces, slashes and punctuation into single dashes", () => {
    expect(slugOf("  Income / spending:  by month ")).toBe("income-spending-by-month");
  });

  test("keeps the letter under a Finnish accent", () => {
    expect(slugOf("Säästöt ja määrä – Åland")).toBe("saastot-ja-maara-aland");
  });

  test("falls back when nothing usable is left", () => {
    expect(slugOf("資産 / €")).toBe("chart");
  });
});

describe("exportFileName", () => {
  test("names the app, the chart and the local day", () => {
    expect(exportFileName("Value (incl. cash)", "png", new Date(2026, 10, 9, 23, 30))).toBe(
      "promptfolio-value-incl-cash-2026-11-09.png",
    );
  });
});

type FakeSwatch = {
  readonly background: string;
  readonly image?: string;
  readonly opacity?: string;
};
const item = (texts: readonly string[], swatch: FakeSwatch | null) => ({
  childNodes: texts.map((textContent) => ({ textContent })),
  querySelector: () => swatch,
});
const styleOf = (swatch: FakeSwatch) => ({
  backgroundColor: swatch.background,
  backgroundImage: swatch.image ?? "none",
  opacity: swatch.opacity ?? "1",
});

describe("readLegend", () => {
  test("returns each entry's resolved swatch colour and its words", () => {
    const frame = {
      querySelectorAll: () => [
        item(["", "Shares", "€6,000.00", "60.0 %"], { background: "rgb(42, 120, 214)" }),
        item(["", " S1 ", "(S1 expected)"], { background: "rgb(235, 104, 52)", opacity: "0.3" }),
      ],
    };

    expect(readLegend(frame, styleOf)).toEqual([
      { colour: "rgb(42, 120, 214)", label: "Shares €6,000.00 60.0 %", opacity: 1 },
      { colour: "rgb(235, 104, 52)", label: "S1 (S1 expected)", opacity: 0.3 },
    ]);
  });

  test("reads a dashed swatch's colour out of its gradient", () => {
    const frame = {
      querySelectorAll: () => [
        item(["", "Invested"], {
          background: "rgba(0, 0, 0, 0)",
          image:
            "repeating-linear-gradient(90deg, rgb(235, 104, 52) 0px, rgb(235, 104, 52) 4px, rgba(0, 0, 0, 0) 4px)",
        }),
      ],
    };

    expect(readLegend(frame, styleOf)[0]?.colour).toBe("rgb(235, 104, 52)");
  });

  test("skips an entry with no swatch or no words", () => {
    const frame = {
      querySelectorAll: () => [item(["Loose"], null), item([""], { background: "rgb(1, 2, 3)" })],
    };

    expect(readLegend(frame, styleOf)).toEqual([]);
  });
});

type FakeNode = {
  readonly computed: Record<string, string>;
  readonly children: FakeNode[];
  readonly inlined: Map<string, string>;
  readonly style: { readonly setProperty: (name: string, value: string) => void };
};
const node = (computed: Record<string, string>, children: FakeNode[] = []): FakeNode => {
  const inlined = new Map<string, string>();
  return {
    computed,
    children,
    inlined,
    style: { setProperty: (name, value) => void inlined.set(name, value) },
  };
};
const inlinedOf = (target: FakeNode): Record<string, string> => Object.fromEntries(target.inlined);
const lookup = (source: FakeNode) => ({
  getPropertyValue: (name: string) => source.computed[name] ?? "",
});

describe("inlinePaint", () => {
  test("writes the resolved colour where the source had a CSS variable", () => {
    // The browser's computed style has already resolved `var(--series-3)`.
    const source = node({ color: "rgb(19, 35, 26)" }, [
      node({ fill: "rgb(27, 175, 122)", stroke: "none", color: "rgb(19, 35, 26)" }),
    ]);
    const copy = node({}, [node({})]);

    inlinePaint(source, copy, lookup);

    expect(inlinedOf(copy.children[0]!)).toMatchObject({
      fill: "rgb(27, 175, 122)",
      stroke: "none",
      color: "rgb(19, 35, 26)",
    });
    expect(Object.values(inlinedOf(copy.children[0]!)).join(" ")).not.toContain("var(");
  });

  test("replaces currentColor with the element's own text colour", () => {
    const source = node({ fill: "currentcolor", color: "rgb(233, 241, 231)" });
    const copy = node({});

    inlinePaint(source, copy, lookup);

    expect(inlinedOf(copy).fill).toBe("rgb(233, 241, 231)");
  });

  test("carries the font, which `inherit` would lose outside the page", () => {
    const source = node({ "font-family": "Inter, sans-serif", "font-size": "11px" });
    const copy = node({});

    inlinePaint(source, copy, lookup);

    expect(inlinedOf(copy)).toMatchObject({
      "font-family": "Inter, sans-serif",
      "font-size": "11px",
    });
  });
});

describe("legendRows", () => {
  const entries = ["Aa", "Bbbb", "Cc"].map((label) => ({ colour: "red", label, opacity: 1 }));
  // Ten pixels a letter, so widths are easy to read off.
  const widthOf = (label: string) => label.length * 10;

  test("keeps entries on one row while they fit", () => {
    expect(legendRows(entries, widthOf, 1000)).toHaveLength(1);
  });

  test("wraps to a new row instead of running off a narrow chart", () => {
    const rows = legendRows(entries, widthOf, 100);

    expect(rows.map((row) => row.map((placed) => placed.entry.label))).toEqual([
      ["Aa"],
      ["Bbbb"],
      ["Cc"],
    ]);
    expect(rows.flat().every((placed) => placed.x === 0)).toBe(true);
  });
});
