import { describe, expect, test } from "vitest";

import { readBytes } from "../files.ts";
import { extractPages } from "./pdf-read.ts";

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
