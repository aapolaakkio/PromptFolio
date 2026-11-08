/**
 * Reads a PDF with a model. The text layer comes out page by page, pages are
 * batched to fit the model's context, and each batch is asked to fill one of
 * three JSON shapes -- a bank statement, a holdings statement, a list of
 * transactions. Nothing here touches the ledger: a reading is a draft the
 * owner reviews, and its checks live with each flow.
 */

import { z } from "zod";

import type { ChatClient } from "../chat/runner.ts";

export type PdfPage = { readonly number: number; readonly text: string };

const NO_TEXT = "PDF ei sisällä tekstiä (skannattu kuva?); tuo tapahtumat CSV-muodossa";

/** One entry per page. Throws when the document has no text layer at all. */
export const extractPages = async (bytes: ArrayBuffer): Promise<PdfPage[]> => {
  const { extractText, getDocumentProxy } = await import("unpdf");
  // pdf.js takes ownership of the array it is given and detaches the buffer,
  // so a copy goes in: the caller hashes the same bytes afterwards.
  const pdf = await getDocumentProxy(new Uint8Array(bytes.slice(0)));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = text.map((pageText, index) => ({ number: index + 1, text: pageText }));
  if (pages.every((page) => page.text.trim() === "")) throw new Error(NO_TEXT);
  return pages;
};

const wordCount = (text: string): number => text.split(/\s+/).filter((w) => w !== "").length;

/** Roughly what the reading model takes comfortably with room for its answer. */
const DEFAULT_BATCH_WORDS = 6000;

/**
 * Consecutive pages grouped under a word budget. A page over the budget on its
 * own is still sent, alone: dropping it would drop its rows without a word.
 */
export const batchPages = (
  pages: readonly PdfPage[],
  maxWords: number = DEFAULT_BATCH_WORDS,
): PdfPage[][] => {
  const batches: PdfPage[][] = [];
  let current: PdfPage[] = [];
  let words = 0;
  for (const page of pages) {
    const size = wordCount(page.text);
    if (current.length > 0 && words + size > maxWords) {
      batches.push(current);
      current = [];
      words = 0;
    }
    current = [...current, page];
    words += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
};

export const PDF_READ_MODEL = "claude-opus-5-5";
/** Room for a few hundred rows of JSON. */
const MAX_TOKENS = 32000;

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A decimal as printed, sign allowed, dot or comma; parsed by each flow with core/money. */
const Decimal = z.string().regex(/^-?\d+([.,]\d+)?$/);

export type ReadProblem = { readonly line: number; readonly text: string };
const Problems = z.array(z.object({ line: z.number().int(), text: z.string() }));

const HoldingsBatch = z.object({
  asOf: IsoDate.nullable(),
  totalValue: Decimal.nullable(),
  holdings: z.array(
    z.object({
      name: z.string().min(1),
      isin: z.string().nullable(),
      quantity: Decimal,
      marketValue: Decimal,
      currency: z.string().length(3),
    }),
  ),
  problems: Problems,
});
export const HoldingsReading = HoldingsBatch.extend({ asOf: IsoDate });
export type HoldingsReading = z.infer<typeof HoldingsReading>;

export const TransactionsReading = z.object({
  transactions: z.array(
    z.object({
      date: IsoDate,
      type: z.enum([
        "BUY",
        "SELL",
        "DIVIDEND",
        "DEPOSIT",
        "WITHDRAWAL",
        "FEE",
        "TRANSFER_IN",
        "TRANSFER_OUT",
        "INTEREST",
      ]),
      name: z.string(),
      isin: z.string().nullable(),
      quantity: Decimal,
      unitPrice: Decimal.nullable(),
      amount: Decimal,
      fee: Decimal,
      tax: Decimal,
      currency: z.string().length(3),
    }),
  ),
  problems: Problems,
});
export type TransactionsReading = z.infer<typeof TransactionsReading>;

const UNREADABLE = "Malli ei palauttanut luettavaa vastausta";

const RULES = [
  "Kopioi luvut täsmälleen kuten ne on painettu, muuttamatta desimaaleja. Negatiivinen summa tarkoittaa rahan lähtemistä.",
  "Päivämäärät muodossa YYYY-MM-DD.",
  "Jos et saa riviä luettua varmasti, jätä se pois ja lisää se problems-listaan painettuine tekstineen. Älä arvaa.",
  "Älä koskaan keksi ISIN-koodia: jos sitä ei ole painettu, anna null.",
  "Kenttä jota tällä sivulla ei ole, on null.",
  "Vastaa pelkällä JSON-oliolla.",
].join("\n");

const PROMPTS = {
  holdings:
    "Tämä on arvopaperisäilytyksen tai salkun omistusotteen tekstisisältö. Poimi otteen päivä, mahdollinen painettu kokonaisarvo, ja jokainen omistus (nimi, ISIN jos painettu, määrä, markkina-arvo, valuutta).",
  transactions:
    "Tämä on välittäjän tapahtumaluettelon tekstisisältö. Poimi jokainen tapahtuma: päivä, laji (BUY, SELL, DIVIDEND, DEPOSIT, WITHDRAWAL, FEE, TRANSFER_IN, TRANSFER_OUT tai INTEREST), arvopaperin nimi, ISIN jos painettu, määrä, yksikköhinta, kokonaissumma etumerkkeineen, kulut, vero ja valuutta.",
} as const;

/**
 * One batch to the model, parsed with the batch schema. A reply that is not
 * JSON, or not this JSON, is refused: a figure the schema did not vouch for
 * must not reach a preview.
 */
const ask = async <T>(
  client: ChatClient,
  schema: z.ZodType<T>,
  prompt: string,
  batch: readonly PdfPage[],
): Promise<T> => {
  const text = batch.map((page) => `--- sivu ${page.number} ---\n${page.text}`).join("\n\n");
  const reply = await client.run({
    model: PDF_READ_MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      { role: "system", content: `${prompt}\n\n${RULES}` },
      { role: "user", content: text },
    ],
    tools: [],
    response_format: { type: "json_schema", json_schema: z.toJSONSchema(schema) },
  });
  const start = reply.text.indexOf("{");
  const end = reply.text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(UNREADABLE);
  let raw: unknown;
  try {
    raw = JSON.parse(reply.text.slice(start, end + 1));
  } catch {
    throw new Error(UNREADABLE);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(UNREADABLE);
  return parsed.data;
};

/** The whole document as batches, each read in turn. `maxWords` is for tests. */
const readBatches = async <T>(
  pages: readonly PdfPage[],
  client: ChatClient,
  schema: z.ZodType<T>,
  prompt: string,
  maxWords?: number,
): Promise<T[]> => {
  const out: T[] = [];
  for (const batch of batchPages(pages, maxWords))
    out.push(await ask(client, schema, prompt, batch));
  return out;
};

const firstNonNull = <T>(values: readonly (T | null)[]): T | null =>
  values.find((value): value is T => value !== null) ?? null;

export const readHoldingsPdf = async (
  pages: readonly PdfPage[],
  client: ChatClient,
  maxWords?: number,
): Promise<HoldingsReading> => {
  const batches = await readBatches(pages, client, HoldingsBatch, PROMPTS.holdings, maxWords);
  const merged = {
    asOf: firstNonNull(batches.map((b) => b.asOf)),
    totalValue: firstNonNull(batches.map((b) => b.totalValue)),
    holdings: batches.flatMap((b) => b.holdings),
    problems: batches.flatMap((b) => b.problems),
  };
  const parsed = HoldingsReading.safeParse(merged);
  if (!parsed.success) throw new Error(UNREADABLE);
  return parsed.data;
};

export const readTransactionsPdf = async (
  pages: readonly PdfPage[],
  client: ChatClient,
  maxWords?: number,
): Promise<TransactionsReading> => {
  const batches = await readBatches(
    pages,
    client,
    TransactionsReading,
    PROMPTS.transactions,
    maxWords,
  );
  return {
    transactions: batches.flatMap((b) => b.transactions),
    problems: batches.flatMap((b) => b.problems),
  };
};
