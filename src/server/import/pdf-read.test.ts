import { describe, expect, test } from "vitest";

import { readBytes } from "../files.ts";
import { extractPages } from "./pdf-read.ts";

const fixture = (name: string) => readBytes(`${import.meta.dirname}/fixtures/${name}`);

/** A minimal PDF with one line of text per page; pdf.js rebuilds the missing cross-reference table. */
const pdfWithPages = (count: number): ArrayBuffer => {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${count} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...Array.from({ length: count }, (_, i) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      (() => {
        const stream = `BT /F1 12 Tf 10 100 Td (Page ${i + 1} text) Tj ET`;
        return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
      })(),
    ]).flat(),
  ];
  const body = objects.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join("");
  return new TextEncoder().encode(
    `%PDF-1.4\n${body}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\n%%EOF`,
  ).buffer;
};

describe("extractPages", () => {
  test("reads only the first pages when given a page limit", async () => {
    const all = await extractPages(pdfWithPages(5));
    expect(all.map((page) => page.number)).toEqual([1, 2, 3, 4, 5]);
    const first = await extractPages(pdfWithPages(5), 2);
    expect(first.map((page) => page.number)).toEqual([1, 2]);
    expect(first[1]?.text).toContain("Page 2 text");
  });

  test("returns one entry per page, numbered from one, with the page's text", async () => {
    const pages = await extractPages(await fixture("op-statement-sample.pdf"));
    expect(pages.length).toBeGreaterThan(0);
    expect(pages[0]?.number).toBe(1);
    expect(pages[0]?.text).toContain("Saldo");
  });

  test("refuses a scanned PDF with no text layer, naming the way round it", async () => {
    await expect(extractPages(await fixture("scanned-no-text.pdf"))).rejects.toThrow(
      /scanned image/,
    );
  });
});
