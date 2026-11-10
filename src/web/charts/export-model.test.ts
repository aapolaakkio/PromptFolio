import { describe, expect, test } from "vitest";

import { exportFileName, legendRows, readLegend, slugOf } from "./export-model.ts";

describe("slugOf", () => {
  test("turns spaces, slashes and punctuation into single dashes", () => {
    expect(slugOf("  Income / spending:  by month ")).toBe("income-spending-by-month");
  });

  test("keeps the letter under a Finnish accent", () => {
    expect(slugOf("Säästöt ja määrä – Åland")).toBe("saastot-ja-maara-aland");
  });

  test("caps a long chat title, so the file name stays under what Windows accepts", () => {
    const slug = slugOf(`${"a".repeat(59)} tail ${"b".repeat(200)}`);

    expect(slug).toBe("a".repeat(59));
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
