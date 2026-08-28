import { expect, test } from "bun:test";

import { extractPdfTextRuns } from "./pdf-text";

const fixture = (name: string): Promise<Uint8Array> =>
  Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).bytes();

// A statement drawn in a standard font: the literal strings are readable as they
// stand, which is the easy case and the one OP's report happens to be.
test("reads text drawn in a standard font", async () => {
  const runs = extractPdfTextRuns(await fixture("op-holdings-sample.pdf"));
  expect(runs).toContain("OMISTUKSET");
});

// A statement drawn in an embedded subset font: the strings are two-byte glyph
// codes that mean nothing without the font's own ToUnicode map. This is what a
// real Nordnet year report does, and reading it as plain bytes yields gibberish.
test("decodes a subset font through its ToUnicode map", async () => {
  const runs = extractPdfTextRuns(await fixture("subset-font-sample.pdf"));
  expect(runs).toEqual(["Vuosiyhteenveto 2025 Osakesäästötili"]);
});

// The fixture octal-escapes every byte a producer would, including the glyph
// codes themselves. Leaving `\303` as four characters misaligns every code that
// follows, so the failure is not one wrong character but the rest of the string.
test("survives octal-escaped bytes without losing alignment", async () => {
  const runs = extractPdfTextRuns(await fixture("subset-font-sample.pdf"));
  expect(runs[0]).toContain("Osakesäästötili");
});

// TextDecoder("latin1") is an alias for windows-1252, which rewrites bytes
// 0x80-0x9F into typographic characters -- 0x99 becomes U+2122. That silently
// corrupted every glyph code above 127 and made a real statement decode to
// "Vuosytnvto" instead of "Vuosiyhteenveto".
test("byte values above 127 survive as themselves", async () => {
  const runs = extractPdfTextRuns(await fixture("subset-font-sample.pdf"));
  expect(runs[0]).not.toContain("™");
  expect(runs[0]).toStartWith("Vuosiyhteenveto");
});

test("a file with no page yields no runs rather than inventing any", () => {
  expect(extractPdfTextRuns(new TextEncoder().encode("%PDF-1.7\nnothing here\n%%EOF\n"))).toEqual(
    [],
  );
});
