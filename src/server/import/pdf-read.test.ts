import { describe, expect, test } from "vitest";

import { readBytes } from "../files.ts";
import { batchPages, extractPages, type PdfPage } from "./pdf-read.ts";

const fixture = (name: string) => readBytes(`${import.meta.dirname}/fixtures/${name}`);

describe("extractPages", () => {
  test("returns one entry per page, numbered from one, with the page's text", async () => {
    const pages = await extractPages(await fixture("op-statement-sample.pdf"));
    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0]?.number).toBe(1);
    expect(pages[0]?.text).toContain("Saldo");
  });

  test("refuses a scanned PDF with no text layer, naming the way round it", async () => {
    await expect(extractPages(await fixture("scanned-no-text.pdf"))).rejects.toThrow(/skannattu/);
  });
});

describe("batchPages", () => {
  const page = (number: number, words: number): PdfPage => ({
    number,
    text: Array.from({ length: words }, () => "sana").join(" "),
  });

  test("keeps consecutive pages together while they fit", () => {
    const batches = batchPages([page(1, 100), page(2, 100), page(3, 100)], 250);
    expect(batches.map((batch) => batch.map((p) => p.number))).toEqual([[1, 2], [3]]);
  });

  test("a page larger than the limit is a batch of its own", () => {
    const batches = batchPages([page(1, 10), page(2, 500), page(3, 10)], 100);
    expect(batches.map((batch) => batch.map((p) => p.number))).toEqual([[1], [2], [3]]);
  });

  test("no pages, no batches", () => {
    expect(batchPages([])).toEqual([]);
  });
});
