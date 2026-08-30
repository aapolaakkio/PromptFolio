import { describe, expect, test } from "bun:test";

import { parseInline, parseMarkdown } from "./parse";

describe("parseInline", () => {
  test("marks bold, italic and code, and keeps the rest as text", () => {
    expect(parseInline("Salkun arvo on **1 234,56 €** ja `get_holdings` kertoo sen")).toEqual([
      { type: "text", text: "Salkun arvo on " },
      { type: "bold", text: "1 234,56 €" },
      { type: "text", text: " ja " },
      { type: "code", text: "get_holdings" },
      { type: "text", text: " kertoo sen" },
    ]);
  });

  test("leaves asterisks inside code alone", () => {
    // Code is matched first, so a payee written `A**B` stays those characters.
    expect(parseInline("`a**b`")).toEqual([{ type: "code", text: "a**b" }]);
  });

  test("keeps a link's text and drops where it points", () => {
    // An answer can quote text that came out of a bank statement. A clickable
    // destination built from that is a phishing surface, and there is nothing
    // on the other end of it worth reaching.
    expect(parseInline("katso [ohje](https://example.invalid/pay)")).toEqual([
      { type: "text", text: "katso ohje" },
    ]);
  });
});

describe("parseMarkdown", () => {
  test("joins wrapped lines into one paragraph and splits on a blank line", () => {
    const blocks = parseMarkdown("Ensimmäinen rivi\njatkuu tässä.\n\nToinen kappale.");

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: "paragraph",
      spans: [{ type: "text", text: "Ensimmäinen rivi jatkuu tässä." }],
    });
  });

  test("reads bullet and numbered lists", () => {
    const blocks = parseMarkdown("- ruoka\n- liikenne\n\n1. eka\n2. toka");

    expect(blocks[0]).toMatchObject({ type: "list", ordered: false });
    expect(blocks[0]).toMatchObject({
      items: [[{ type: "text", text: "ruoka" }], [{ type: "text", text: "liikenne" }]],
    });
    expect(blocks[1]).toMatchObject({ type: "list", ordered: true });
  });

  test("reads a table of figures", () => {
    const blocks = parseMarkdown(
      "| Luokka | Summa |\n| --- | ---: |\n| Ruoka | -73,35 |\n| Liikenne | -20,00 |",
    );

    expect(blocks[0]).toMatchObject({ type: "table" });
    expect(blocks[0]).toMatchObject({
      header: [[{ type: "text", text: "Luokka" }], [{ type: "text", text: "Summa" }]],
    });
    expect(blocks[0]).toMatchObject({
      rows: [
        [[{ type: "text", text: "Ruoka" }], [{ type: "text", text: "-73,35" }]],
        [[{ type: "text", text: "Liikenne" }], [{ type: "text", text: "-20,00" }]],
      ],
    });
  });

  test("does not read a line of pipes as a table without its separator", () => {
    const blocks = parseMarkdown("| ei | otsikkoa |");

    expect(blocks[0]?.type).toBe("paragraph");
  });

  test("keeps a code block's own line breaks", () => {
    const blocks = parseMarkdown("teksti\n\n```\neka\ntoka\n```");

    expect(blocks[1]).toEqual({ type: "code", text: "eka\ntoka" });
  });

  test("shows the contents of a fence the model never closed", () => {
    // Swallowing the rest of the answer is the worse failure: the reader sees
    // nothing at all and cannot tell that anything was said.
    const blocks = parseMarkdown("```\nkeskeneräinen");

    expect(blocks[0]).toEqual({ type: "code", text: "keskeneräinen" });
  });

  test("reads headings up to three deep", () => {
    expect(parseMarkdown("### Yhteenveto")[0]).toEqual({
      type: "heading",
      level: 3,
      spans: [{ type: "text", text: "Yhteenveto" }],
    });
  });

  test("returns nothing for an empty answer rather than an empty paragraph", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("   \n\n  ")).toEqual([]);
  });
});
