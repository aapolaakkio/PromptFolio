import { describe, expect, test } from "vitest";

import { readBytes } from "../files.ts";
import type { ChatClient, TurnParams } from "../chat/runner.ts";
import {
  batchPages,
  extractPages,
  PDF_READ_MODEL,
  readHoldingsPdf,
  readTransactionsPdf,
  type PdfPage,
} from "./pdf-read.ts";

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

/** A model that answers each call with the next scripted JSON text. */
const scripted = (replies: unknown[], seen: TurnParams[] = []): ChatClient => ({
  run: (params) => {
    seen.push(params);
    const reply = replies[seen.length - 1];
    if (reply === undefined) throw new Error("scripted model ran out of replies");
    return Promise.resolve({ text: JSON.stringify(reply), toolCalls: [] });
  },
});

const page = (number: number, text: string): PdfPage => ({ number, text });

describe("readHoldingsPdf", () => {
  test("merges holdings across batches and keeps the printed total", async () => {
    const reading = await readHoldingsPdf(
      [page(1, "a"), page(2, "b")],
      scripted([
        {
          asOf: "2026-06-30",
          totalValue: "1000.00",
          holdings: [
            {
              name: "Nokia",
              isin: "FI0009000681",
              quantity: "10",
              marketValue: "40.00",
              currency: "EUR",
            },
          ],
          problems: [],
        },
        {
          asOf: null,
          totalValue: null,
          holdings: [
            {
              name: "OP-Maailma",
              isin: null,
              quantity: "1.5",
              marketValue: "960.00",
              currency: "EUR",
            },
          ],
          problems: [],
        },
      ]),
      1,
    );
    expect(reading.asOf).toBe("2026-06-30");
    expect(reading.totalValue).toBe("1000.00");
    expect(reading.holdings.map((h) => h.name)).toEqual(["Nokia", "OP-Maailma"]);
  });

  /**
   * The reading model and the JSON schema the reply is held to. Asserted here
   * because `ask` is shared by every PDF reader, and a reply the schema never
   * vouched for must not reach a preview.
   */
  test("asks the reading model for an answer in the batch's own JSON schema", async () => {
    const seen: TurnParams[] = [];
    await readHoldingsPdf(
      [page(1, "a")],
      scripted([{ asOf: "2026-06-30", totalValue: null, holdings: [], problems: [] }], seen),
    );

    expect(seen[0]?.model).toBe(PDF_READ_MODEL);
    expect(seen[0]?.response_format?.type).toBe("json_schema");
  });
});

describe("readTransactionsPdf", () => {
  test("concatenates the rows of every batch", async () => {
    const row = (date: string) => ({
      date,
      type: "BUY",
      name: "Nokia",
      isin: "FI0009000681",
      quantity: "10",
      unitPrice: "4.15",
      amount: "-41.50",
      fee: "0.00",
      tax: "0.00",
      currency: "EUR",
    });
    const reading = await readTransactionsPdf(
      [page(1, "a"), page(2, "b")],
      scripted([
        { transactions: [row("2025-01-10")], problems: [] },
        { transactions: [row("2025-02-10")], problems: [{ line: 3, text: "rivi" }] },
      ]),
      1,
    );
    expect(reading.transactions.map((t) => t.date)).toEqual(["2025-01-10", "2025-02-10"]);
    expect(reading.problems).toHaveLength(1);
  });
});
