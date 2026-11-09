import { describe, expect, test } from "vitest";

import { parseInline, parseMarkdown } from "./parse.ts";

describe("parseInline", () => {
  test("marks bold, italic and code, and keeps the rest as text", () => {
    expect(parseInline("The portfolio is worth **€1,234.56** and `get_holdings` says so")).toEqual([
      { type: "text", text: "The portfolio is worth " },
      { type: "bold", text: "€1,234.56" },
      { type: "text", text: " and " },
      { type: "code", text: "get_holdings" },
      { type: "text", text: " says so" },
    ]);
  });

  test("leaves asterisks inside code alone", () => {
    // Code is matched first, so a payee written `A**B` stays those characters.
    expect(parseInline("`a**b`")).toEqual([{ type: "code", text: "a**b" }]);
  });

  test("keeps a link's text and drops where it points", () => {
    // A destination built from statement text is a phishing surface.
    expect(parseInline("see [guide](https://example.invalid/pay)")).toEqual([
      { type: "text", text: "see guide" },
    ]);
  });
});

describe("parseMarkdown", () => {
  test("joins wrapped lines into one paragraph and splits on a blank line", () => {
    const blocks = parseMarkdown("First line\ncontinues here.\n\nSecond paragraph.");

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: "paragraph",
      spans: [{ type: "text", text: "First line continues here." }],
    });
  });

  test("reads bullet and numbered lists", () => {
    const blocks = parseMarkdown("- food\n- transport\n\n1. first\n2. second");

    expect(blocks[0]).toMatchObject({ type: "list", ordered: false });
    expect(blocks[0]).toMatchObject({
      items: [[{ type: "text", text: "food" }], [{ type: "text", text: "transport" }]],
    });
    expect(blocks[1]).toMatchObject({ type: "list", ordered: true });
  });

  test("reads a table of figures", () => {
    const blocks = parseMarkdown(
      "| Category | Amount |\n| --- | ---: |\n| Food | -73.35 |\n| Transport | -20.00 |",
    );

    expect(blocks[0]).toMatchObject({ type: "table" });
    expect(blocks[0]).toMatchObject({
      header: [[{ type: "text", text: "Category" }], [{ type: "text", text: "Amount" }]],
    });
    expect(blocks[0]).toMatchObject({
      rows: [
        [[{ type: "text", text: "Food" }], [{ type: "text", text: "-73.35" }]],
        [[{ type: "text", text: "Transport" }], [{ type: "text", text: "-20.00" }]],
      ],
    });
  });

  test("does not read a line of pipes as a table without its separator", () => {
    const blocks = parseMarkdown("| no | separator |");

    expect(blocks[0]?.type).toBe("paragraph");
  });

  test("keeps a code block's own line breaks", () => {
    const blocks = parseMarkdown("text\n\n```\nfirst\nsecond\n```");

    expect(blocks[1]).toEqual({ type: "code", text: "first\nsecond" });
  });

  test("shows the contents of a fence the model never closed", () => {
    // Swallowing the rest of the answer is the worse failure.
    const blocks = parseMarkdown("```\nunfinished");

    expect(blocks[0]).toEqual({ type: "code", text: "unfinished" });
  });

  test("reads headings up to three deep", () => {
    expect(parseMarkdown("### Summary")[0]).toEqual({
      type: "heading",
      level: 3,
      spans: [{ type: "text", text: "Summary" }],
    });
  });

  test("returns nothing for an empty answer rather than an empty paragraph", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("   \n\n  ")).toEqual([]);
  });
});
