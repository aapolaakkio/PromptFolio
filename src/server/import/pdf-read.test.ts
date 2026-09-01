import { describe, expect, test } from "vitest";

import { readBytes } from "../files.ts";
import type { ChatClient, TurnParams } from "../chat/runner.ts";
import {
  batchPages,
  extractPages,
  PDF_READ_MODEL,
  readBankPdf,
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

describe("readBankPdf", () => {
  const first = {
    from: "2025-08-28",
    to: null,
    openingBalance: "1500.00",
    closingBalance: null,
    maturityDate: null,
    rows: [
      {
        date: "2025-09-01",
        amount: "-25.90",
        counterparty: "K-MARKET",
        message: "",
        reference: "1",
      },
    ],
    problems: [],
  };
  const last = {
    from: null,
    to: "2026-08-28",
    openingBalance: null,
    closingBalance: "3236.44",
    maturityDate: "2027-02-01",
    rows: [
      { date: "2026-08-01", amount: "12.34", counterparty: "", message: "Korko", reference: null },
    ],
    problems: [{ line: 7, text: "1.2.2026 ??? 40,00" }],
  };

  test("asks in JSON mode with the reading model, one call per batch", async () => {
    const seen: TurnParams[] = [];
    await readBankPdf([page(1, "a"), page(2, "b")], scripted([first, last], seen), 1);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.model).toBe(PDF_READ_MODEL);
    expect(seen[0]?.response_format?.type).toBe("json_schema");
    expect(seen[0]?.messages.at(-1)?.content).toContain("a");
    expect(seen[1]?.messages.at(-1)?.content).toContain("b");
  });

  test("takes the opening facts from the first batch, the closing ones from the last, and every row", async () => {
    const reading = await readBankPdf([page(1, "a"), page(2, "b")], scripted([first, last]), 1);
    expect(reading.from).toBe("2025-08-28");
    expect(reading.to).toBe("2026-08-28");
    expect(reading.openingBalance).toBe("1500.00");
    expect(reading.closingBalance).toBe("3236.44");
    expect(reading.maturityDate).toBe("2027-02-01");
    expect(reading.rows.map((row) => row.amount)).toEqual(["-25.90", "12.34"]);
    expect(reading.problems).toEqual([{ line: 7, text: "1.2.2026 ??? 40,00" }]);
  });

  test("a statement whose facts never arrive is refused as unreadable", async () => {
    const empty = { ...first, from: null, openingBalance: null };
    await expect(readBankPdf([page(1, "a")], scripted([empty]))).rejects.toThrow(/luettavaa/);
  });

  test("a reply that is not the shape is refused, not guessed at", async () => {
    await expect(readBankPdf([page(1, "a")], scripted([{ nonsense: true }]))).rejects.toThrow(
      /luettavaa/,
    );
  });
});

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
