import { expect, test } from "bun:test";

import { parseOpHoldings } from "./op-pdf";
import { extractPdfTextRuns } from "./pdf-text";

// A synthetic statement in the shape OP's real year-end report takes, generated
// rather than captured: same layout, same column order, same multi-lot fund,
// invented names and figures. Verified against a genuine 2-page statement,
// which produced the same structure and parsed identically.
const fixture = (): Promise<Uint8Array> =>
  Bun.file(new URL("./fixtures/op-holdings-sample.pdf", import.meta.url)).bytes();

test("reads the text layer out of a compressed PDF", async () => {
  const runs = extractPdfTextRuns(await fixture());
  expect(runs.length).toBeGreaterThan(20);
  expect(runs).toContain("OMISTUKSET");
});

test("parses each fund's total row into a holding", async () => {
  const statement = parseOpHoldings(await fixture());
  expect(statement.asOf).toBe("2025-12-31");
  expect(statement.holdings).toEqual([
    {
      name: "ESIMERKKI-AASIA INDEKSI A",
      quantity: "15.4552",
      costEur: "3325",
      marketValueEur: "4568.25",
    },
    {
      name: "ESIMERKKI-MAAILMA INDEKSI -SIJOITUSRAHASTO A",
      quantity: "59.0722",
      costEur: "10579.79",
      marketValueEur: "14746.78",
    },
  ]);
});

// The second fund in the fixture has two acquisition lots and the first has one.
// Counting lines from the heading would book one fund's totals against another,
// which is why the parser anchors on the `Omistukset <date>` line instead.
test("a fund with several acquisition lots still reports one total", async () => {
  const statement = parseOpHoldings(await fixture());
  expect(statement.holdings).toHaveLength(2);
  // 40,0000 and 19,0722 are the lots; 59,0722 is the total, and it is the total
  // that must come back.
  expect(statement.holdings[1]!.quantity).toBe("59.0722");
});

test("market value is the broker's own figure, not quantity times a rounded unit price", async () => {
  const statement = parseOpHoldings(await fixture());
  const holding = statement.holdings[0]!;
  // 15,4552 x 295,58 = 4 568,25... but the printed unit value is rounded, so
  // recomputing drifts from the statement. The statement is the authority.
  expect(holding.marketValueEur).toBe("4568.25");
});

test("a PDF with no text layer is refused rather than read as an empty statement", () => {
  const notAPdf = new TextEncoder().encode("%PDF-1.4\nno streams here\n%%EOF\n");
  // An empty result would read as "you held nothing" -- the one thing a
  // holdings statement can never mean.
  expect(() => parseOpHoldings(notAPdf)).toThrow(/ei löytynyt tekstiä/);
});

test("a PDF whose text is not an OP holdings report is refused", () => {
  const runs = ["Kuitti", "Kiitos ostoksestasi", "12,34"];
  const { deflateSync } = require("node:zlib");
  const content = runs.map((r) => `(${r}) Tj`).join("\n");
  const body = deflateSync(Buffer.from(content, "latin1"));
  const pdf = Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode >>\nstream\n", "latin1"),
    body,
    Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
  ]);
  expect(() => parseOpHoldings(new Uint8Array(pdf))).toThrow(/ei tunnistettu/);
});
