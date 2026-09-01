# Model-read PDFs and editable previews — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any downloaded PDF imports through a Workers AI reading, and every import preview (bank, transactions, holdings; CSV, paste or PDF) can be edited by hand before the edited rows are committed.

**Architecture:** One module reads PDFs page by page through the existing `ChatClient` in JSON mode and returns a zod-parsed "reading" per kind. Each flow turns a reading (or a CSV/paste parse) into a wire-form draft the browser edits; commit takes the draft back as JSON, re-validates it, runs the flow's check, and writes through the existing commit code. The OP PDF parsers are deleted.

**Tech Stack:** TypeScript on Cloudflare Workers, Drizzle + D1, zod 4, `unpdf`, Workers AI (`env.AI`) via `src/server/chat/runner.ts`, TanStack Start server functions, React, vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-model-read-pdfs-and-editable-previews-design.md`

## Global Constraints

- Money and quantities cross the wire as decimal strings, never JSON numbers (spec "Validation and safety"). Existing `DraftTxn` carries minor-unit integers and stays as it is.
- Every server function validates its input with zod at the boundary; no `unknown` parameters, no `as` casts without a `// SAFETY:` comment (repo lint rules `anti-slop/*`).
- No new dependencies.
- Reading model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, as a constant `PDF_READ_MODEL`, independent of the chat picker.
- Tests never reach Workers AI: the test env's `AI` binding throws; every test scripts a `ChatClient`.
- Run `pnpm fmt && pnpm lint && pnpm typecheck && pnpm test` before every commit. The pre-commit hook runs the same.
- Finnish user-facing strings, as everywhere in the app.

---

## File structure

| File                                                                   | Responsibility                                                                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/chat/runner.ts` (modify)                                   | `TurnParams.response_format` passed to the binding, so a caller can ask for JSON.                                                                             |
| `src/server/import/pdf-read.ts` (create)                               | Page extraction, batching, the three reading schemas, one `ask` that calls the model in JSON mode, `readBankPdf` / `readHoldingsPdf` / `readTransactionsPdf`. |
| `src/server/import/bank-draft.ts` (create)                             | `BankDraft` wire schema, conversions to and from `BankRow`, the balance check.                                                                                |
| `src/server/import/bank-service.ts` (modify)                           | Preview returns a `BankDraft`; `commitBankDraft` takes one back. OP PDF parser usage removed.                                                                 |
| `src/server/import/txn-draft.ts` (create)                              | `DraftBody` wire schema for `Draft`, and `transactionsDraftFrom(reading)`.                                                                                    |
| `src/server/import/service.ts` (modify)                                | PDF preview through the reader; `commitDraftBody` replaces the re-parsing commits.                                                                            |
| `src/server/snapshot/holdings-draft.ts` (create)                       | `holdingsTotalCheck`, and `proposalFromReading`.                                                                                                              |
| `src/server/snapshot/service.ts` (modify)                              | `proposeFromPdf`; `CreateSnapshot` gains `statedTotalEur`, checked on save.                                                                                   |
| `src/web/server/{bank-imports,imports,snapshots}.ts` (modify)          | Server functions for the new commit bodies and the PDF proposal.                                                                                              |
| `src/web/routes/draft-edit.ts` (create)                                | Pure row-editing helpers and the live checks, tested without a DOM.                                                                                           |
| `src/web/routes/DraftTable.tsx` (create)                               | The editable table used by all three screens.                                                                                                                 |
| `src/web/routes/cash.tsx`, `imports.tsx`, `SnapshotPaste.tsx` (modify) | Editable previews, commits from the draft.                                                                                                                    |
| Deleted                                                                | `bank-pdf.ts`, `bank-pdf-sweep.ts`, their tests, `fixtures/*.txt` statement texts.                                                                            |

---

### Task 1: JSON mode through the runner

**Files:**

- Modify: `src/server/chat/runner.ts`
- Test: `src/server/chat/runner.test.ts`

**Interfaces:**

- Produces: `TurnParams.response_format?: { readonly type: "json_schema"; readonly json_schema: JSONSchema.BaseSchema }`, forwarded verbatim to `env.AI.run`. Consumers: Task 3.

- [ ] **Step 1: Write the failing test**

Append to `src/server/chat/runner.test.ts` inside `describe("runTurn")`'s sibling scope (top level of the file):

```ts
describe("createClient inputs", () => {
  test("a response_format travels to the binding untouched", async () => {
    const seen: TurnParams[] = [];
    const client: ChatClient = {
      run: (params) => (seen.push(params), Promise.resolve(says("{}"))),
    };
    const schema = z.toJSONSchema(z.object({ ok: z.boolean() }));
    await client.run({
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      max_tokens: 64,
      messages: [{ role: "user", content: "moi" }],
      tools: [],
      response_format: { type: "json_schema", json_schema: schema },
    });
    expect(seen[0]?.response_format).toEqual({ type: "json_schema", json_schema: schema });
  });
});
```

This test only compiles once the field exists on `TurnParams`; that is the failure.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec tsc --noEmit --pretty false 2>&1 | grep runner.test`
Expected: `Object literal may only specify known properties, and 'response_format' does not exist`.

- [ ] **Step 3: Add the field and forward it**

In `src/server/chat/runner.ts`, change `TurnParams`:

```ts
export type TurnParams = {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolDefinition[];
  /**
   * JSON mode, for a reading rather than a conversation. Workers AI's own
   * shape: the schema goes in directly, not wrapped the OpenAI way.
   */
  readonly response_format?: {
    readonly type: "json_schema";
    readonly json_schema: JSONSchema.BaseSchema;
  };
};
```

In `createClient`, replace the `const inputs: ChatCompletionsInput = { ... }` block with an inferred object so the legacy-shaped `response_format` is accepted:

```ts
const inputs = {
  messages: toApiMessages(params.messages),
  tools: [...params.tools],
  max_tokens: params.max_tokens,
  // Answers, not deliberation: the tool loop is where the work happens,
  // and thinking tokens are billed like any other.
  chat_template_kwargs: { enable_thinking: false },
  ...(params.response_format === undefined ? {} : { response_format: params.response_format }),
};
```

The `anti-slop/no-conditional-empty-object-spread` rule refuses that spread. Write it as two statements instead:

```ts
const base = {
  messages: toApiMessages(params.messages),
  tools: [...params.tools],
  max_tokens: params.max_tokens,
  chat_template_kwargs: { enable_thinking: false },
};
const inputs =
  params.response_format === undefined
    ? base
    : { ...base, response_format: params.response_format };
```

`env.AI.run(params.model, inputs, ...)` stays: with a `string` model it uses the fallback overload, which takes `Record<string, unknown>`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/server/chat/runner.test.ts`
Expected: all pass, including the new one.

- [ ] **Step 5: Commit**

```bash
git add src/server/chat/runner.ts src/server/chat/runner.test.ts
git commit -m "feat(chat): let a caller ask the model for JSON"
```

---

### Task 2: Page extraction and batching

**Files:**

- Create: `src/server/import/pdf-read.ts`
- Test: `src/server/import/pdf-read.test.ts`

**Interfaces:**

- Produces:
  - `type PdfPage = { readonly number: number; readonly text: string }`
  - `extractPages(bytes: ArrayBuffer): Promise<PdfPage[]>` — throws `Error("PDF ei sisällä tekstiä (skannattu kuva?); tuo tapahtumat CSV-muodossa")` when no page has text.
  - `batchPages(pages: readonly PdfPage[], maxWords?: number): PdfPage[][]` — consecutive pages grouped so a batch stays under `maxWords` (default 6000); a single page over the limit is a batch of its own.

- [ ] **Step 1: Write the failing tests**

Create `src/server/import/pdf-read.test.ts`:

```ts
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/server/import/pdf-read.test.ts`
Expected: FAIL, `Cannot find module './pdf-read.ts'`.

- [ ] **Step 3: Write the extractor and the batcher**

Create `src/server/import/pdf-read.ts`:

```ts
/**
 * Reads a PDF with a model. The text layer comes out page by page, pages are
 * batched to fit the model's context, and each batch is asked to fill one of
 * three JSON shapes -- a bank statement, a holdings statement, a list of
 * transactions. Nothing here touches the ledger: a reading is a draft the
 * owner reviews, and its checks live with each flow.
 */

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
```

`unpdf`'s `extractText` with `mergePages: false` returns `{ totalPages, text: string[] }`. If the typecheck disagrees with that shape, read `node_modules/unpdf/dist/index.d.mts` and adjust the destructuring; the test against the fixture is the contract.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/server/import/pdf-read.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/import/pdf-read.ts src/server/import/pdf-read.test.ts
git commit -m "feat(import): extract and batch a PDF's pages for the reader"
```

---

### Task 3: The three readings

**Files:**

- Modify: `src/server/import/pdf-read.ts`
- Test: `src/server/import/pdf-read.test.ts`

**Interfaces:**

- Consumes: `ChatClient`, `TurnParams` from `src/server/chat/runner.ts` (Task 1).
- Produces:
  - `PDF_READ_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"`
  - `type ReadProblem = { readonly line: number; readonly text: string }`
  - `BankReading` (zod) → `{ from, to, openingBalance, closingBalance, maturityDate: string | null, rows: { date, amount, counterparty, message, reference: string | null }[], problems: ReadProblem[] }`
  - `HoldingsReading` (zod) → `{ asOf, totalValue: string | null, holdings: { name, isin: string | null, quantity, marketValue, currency }[], problems }`
  - `TransactionsReading` (zod) → `{ transactions: { date, type, name, isin: string | null, quantity, unitPrice: string | null, amount, fee, tax, currency }[], problems }`
  - `readBankPdf(pages, client)`, `readHoldingsPdf(pages, client)`, `readTransactionsPdf(pages, client)` — each `Promise<z.infer<typeof ...Reading>>`; each throws `Error("Malli ei palauttanut luettavaa vastausta")` on a reply that fails to parse.

- [ ] **Step 1: Write the failing tests**

Append to `src/server/import/pdf-read.test.ts`:

```ts
import type { ChatClient, TurnParams } from "../chat/runner.ts";
import { PDF_READ_MODEL, readBankPdf, readHoldingsPdf, readTransactionsPdf } from "./pdf-read.ts";

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
```

Move the `import type { ChatClient, TurnParams }` line to the top of the file with the other imports, and merge the two `./pdf-read.ts` imports into one.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/server/import/pdf-read.test.ts`
Expected: FAIL, `readBankPdf is not a function` (and the type errors on the missing exports).

- [ ] **Step 3: Write the schemas, the prompt, and the three readers**

Append to `src/server/import/pdf-read.ts`:

```ts
import { z } from "zod";

import type { ChatClient } from "../chat/runner.ts";

export const PDF_READ_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
/** Room for a few hundred rows of JSON. */
const MAX_TOKENS = 8192;

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A decimal as printed, sign allowed, dot or comma; parsed by each flow with core/money. */
const Decimal = z.string().regex(/^-?\d+([.,]\d+)?$/);

export type ReadProblem = { readonly line: number; readonly text: string };
const Problems = z.array(z.object({ line: z.number().int(), text: z.string() }));

/** One batch's answer: header facts are nullable because a middle page has none. */
const BankBatch = z.object({
  from: IsoDate.nullable(),
  to: IsoDate.nullable(),
  openingBalance: Decimal.nullable(),
  closingBalance: Decimal.nullable(),
  maturityDate: IsoDate.nullable(),
  rows: z.array(
    z.object({
      date: IsoDate,
      amount: Decimal,
      counterparty: z.string(),
      message: z.string(),
      reference: z.string().nullable(),
    }),
  ),
  problems: Problems,
});

export const BankReading = BankBatch.extend({
  from: IsoDate,
  to: IsoDate,
  openingBalance: Decimal,
  closingBalance: Decimal,
});
export type BankReading = z.infer<typeof BankReading>;

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
  bank: "Tämä on pankin tiliotteen tekstisisältö. Poimi jakso, alku- ja loppusaldo, mahdollinen eräpäivä, ja jokainen tilitapahtuma (päivä, summa etumerkkeineen, maksunsaaja tai maksaja, viesti, arkistointitunnus).",
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

export const readBankPdf = async (
  pages: readonly PdfPage[],
  client: ChatClient,
  maxWords?: number,
): Promise<BankReading> => {
  const batches = await readBatches(pages, client, BankBatch, PROMPTS.bank, maxWords);
  // Opening facts are printed at the top, closing ones at the bottom: the
  // first batch that has them wins for one, the last for the other.
  const merged = {
    from: firstNonNull(batches.map((b) => b.from)),
    openingBalance: firstNonNull(batches.map((b) => b.openingBalance)),
    to: firstNonNull([...batches].reverse().map((b) => b.to)),
    closingBalance: firstNonNull([...batches].reverse().map((b) => b.closingBalance)),
    maturityDate: firstNonNull(batches.map((b) => b.maturityDate)),
    rows: batches.flatMap((b) => b.rows),
    problems: batches.flatMap((b) => b.problems),
  };
  const parsed = BankReading.safeParse(merged);
  if (!parsed.success) throw new Error(UNREADABLE);
  return parsed.data;
};

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
```

Put the `import { z }` and the `ChatClient` import at the top of the file with the others.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/server/import/pdf-read.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/import/pdf-read.ts src/server/import/pdf-read.test.ts
git commit -m "feat(import): read bank, holdings and transaction PDFs with the model"
```

---

### Task 4: The bank draft

**Files:**

- Create: `src/server/import/bank-draft.ts`
- Test: `src/server/import/bank-draft.test.ts`

**Interfaces:**

- Consumes: `BankRow` from `bank-statement.ts`; `BankReading` from Task 3; `parseMoney`, `formatMoney`, `EUR` from `src/core/money.ts`.
- Produces:
  - `BankDraft` (zod, `.strict()`): `{ statement: { from, to, openingBalanceEur, closingBalanceEur, maturityDate: string | null } | null, rows: { line, date, type: "DEPOSIT" | "WITHDRAWAL" | "INTEREST", amountEur, counterparty, message, externalId: string | null }[], problems: { line, text }[] }`
  - `bankDraftFromRows(rows: readonly BankRow[], problems: readonly { line: number; message: string }[]): BankDraft`
  - `bankDraftFromReading(reading: BankReading): BankDraft`
  - `bankRowsFromDraft(draft: BankDraft): BankRow[]` — throws `HttpError(400, ...)` naming the row on a bad amount.
  - `checkBankDraft(draft: BankDraft): { ok: boolean; differenceEur: string } | null` — null when there is no statement to check against.

- [ ] **Step 1: Write the failing tests**

Create `src/server/import/bank-draft.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import {
  BankDraft,
  bankDraftFromReading,
  bankDraftFromRows,
  bankRowsFromDraft,
  checkBankDraft,
} from "./bank-draft.ts";

const reading = {
  from: "2025-08-28",
  to: "2026-08-28",
  openingBalance: "1500,00",
  closingBalance: "3236.44",
  maturityDate: null,
  rows: [
    {
      date: "2025-09-01",
      amount: "-25.90",
      counterparty: "K-MARKET",
      message: "",
      reference: "A1",
    },
    {
      date: "2025-09-02",
      amount: "2750.00",
      counterparty: "TYÖNANTAJA",
      message: "PALKKA",
      reference: null,
    },
    { date: "2026-08-01", amount: "12.34", counterparty: "", message: "KORKO", reference: null },
  ],
  problems: [{ line: 9, text: "epäselvä rivi" }],
};

describe("bankDraftFromReading", () => {
  test("carries the statement, normalises the decimal comma, and types rows by sign or by 'korko'", () => {
    const draft = bankDraftFromReading(reading);
    expect(draft.statement).toEqual({
      from: "2025-08-28",
      to: "2026-08-28",
      openingBalanceEur: "1500.00",
      closingBalanceEur: "3236.44",
      maturityDate: null,
    });
    expect(draft.rows.map((row) => row.type)).toEqual(["WITHDRAWAL", "DEPOSIT", "INTEREST"]);
    expect(draft.rows[0]).toMatchObject({ line: 1, amountEur: "-25.90", externalId: "A1" });
    expect(draft.problems).toEqual([{ line: 9, text: "epäselvä rivi" }]);
  });
});

describe("checkBankDraft", () => {
  test("agrees when the rows account for the closing balance", () => {
    const draft = bankDraftFromReading({ ...reading, closingBalance: "4236.44" });
    expect(checkBankDraft(draft)).toEqual({ ok: true, differenceEur: "0.00" });
  });

  test("reports the difference otherwise, and is null for a CSV draft", () => {
    expect(checkBankDraft(bankDraftFromReading(reading))).toEqual({
      ok: false,
      differenceEur: "-1000.00",
    });
    expect(checkBankDraft(bankDraftFromRows([], []))).toBeNull();
  });
});

describe("bankRowsFromDraft", () => {
  test("round-trips through BankRow, with the note the ledger stores", () => {
    const rows = bankRowsFromDraft(bankDraftFromReading(reading));
    expect(rows[0]).toMatchObject({
      amount: -2590n,
      note: "PKORTTIMAKSU — K-MARKET",
      externalId: "A1",
    });
    expect(rows[2]?.note).toBe("KORKO");
  });

  test("refuses a hand-edited amount that is not a number, naming the row", () => {
    const draft = BankDraft.parse({
      statement: null,
      rows: [
        {
          line: 4,
          date: "2025-01-01",
          type: "DEPOSIT",
          amountEur: "paljon",
          counterparty: "",
          message: "",
          externalId: null,
        },
      ],
      problems: [],
    });
    expect(() => bankRowsFromDraft(draft)).toThrow(/Rivi 4/);
  });
});
```

Check the exact `note` the existing CSV parser builds in `bank-statement.ts` (`rowType` and the note join near line 200) and mirror it: the note is `counterparty` and `message` joined with `" — "`, dropping an empty half. Adjust the first `note` assertion in the test to match what a PDF row without a label should read as: `"K-MARKET"` when the message is empty.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/server/import/bank-draft.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the module**

Create `src/server/import/bank-draft.ts`:

```ts
import { z } from "zod";

import { EUR, formatMoney, parseMoney } from "../../core/money.ts";
import { HttpError } from "../errors.ts";
import type { BankRow } from "./bank-statement.ts";
import type { BankReading } from "./pdf-read.ts";

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Päivämäärän on oltava muotoa YYYY-MM-DD");
const Amount = z.string().min(1, "Summa puuttuu");

/**
 * A bank statement as the browser edits it and sends it back: every figure a
 * decimal string, every row addressable by its line. `statement` is present
 * for a PDF, which prints its balances, and null for a CSV, which does not.
 */
export const BankDraft = z
  .object({
    statement: z
      .object({
        from: IsoDate,
        to: IsoDate,
        openingBalanceEur: Amount,
        closingBalanceEur: Amount,
        maturityDate: IsoDate.nullable(),
      })
      .nullable(),
    rows: z
      .array(
        z
          .object({
            line: z.number().int(),
            date: IsoDate,
            type: z.enum(["DEPOSIT", "WITHDRAWAL", "INTEREST"]),
            amountEur: Amount,
            counterparty: z.string(),
            message: z.string(),
            externalId: z.string().nullable(),
          })
          .strict(),
      )
      .max(5000),
    problems: z.array(z.object({ line: z.number().int(), text: z.string() })),
  })
  .strict();
export type BankDraft = z.infer<typeof BankDraft>;

const normaliseDecimal = (text: string): string => text.replace(",", ".").replace(/\s/g, "");

/** Formats through core/money so "1500,00" and "1500.00" read back identically. */
const asEur = (text: string): string => formatMoney(parseMoney(normaliseDecimal(text), EUR));

const rowType = (amountEur: string, message: string): BankDraft["rows"][number]["type"] => {
  if (/korko/i.test(message)) return "INTEREST";
  return amountEur.trim().startsWith("-") ? "WITHDRAWAL" : "DEPOSIT";
};

export const bankDraftFromReading = (reading: BankReading): BankDraft => ({
  statement: {
    from: reading.from,
    to: reading.to,
    openingBalanceEur: asEur(reading.openingBalance),
    closingBalanceEur: asEur(reading.closingBalance),
    maturityDate: reading.maturityDate,
  },
  rows: reading.rows.map((row, index) => ({
    line: index + 1,
    date: row.date,
    type: rowType(row.amount, row.message),
    amountEur: asEur(row.amount),
    counterparty: row.counterparty.trim(),
    message: row.message.trim(),
    externalId: row.reference,
  })),
  problems: reading.problems,
});

/** A CSV parse into the same draft, so one preview serves both formats. */
export const bankDraftFromRows = (
  rows: readonly BankRow[],
  problems: readonly { line: number; message: string }[],
): BankDraft => ({
  statement: null,
  rows: rows.map((row) => {
    const [counterparty = "", ...rest] = row.note.split(" — ");
    return {
      line: row.line,
      date: row.date,
      type: row.type,
      amountEur: formatMoney({ minor: row.amount, currency: EUR }),
      counterparty: row.counterparty,
      message: row.counterparty === counterparty ? rest.join(" — ") : row.note,
      externalId: row.externalId,
    };
  }),
  problems: problems.map((problem) => ({ line: problem.line, text: problem.message })),
});

const noteOf = (counterparty: string, message: string): string =>
  [counterparty, message].filter((part) => part !== "").join(" — ");

/** The ledger's rows from an edited draft. A bad amount names its row. */
export const bankRowsFromDraft = (draft: BankDraft): BankRow[] =>
  draft.rows.map((row) => {
    let amount: bigint;
    try {
      amount = parseMoney(normaliseDecimal(row.amountEur), EUR).minor;
    } catch {
      throw new HttpError(400, `Rivi ${row.line}: summa "${row.amountEur}" ei ole luku`);
    }
    return {
      line: row.line,
      date: row.date,
      type: row.type,
      amount,
      counterparty: row.counterparty,
      note: noteOf(row.counterparty, row.message),
      externalId: row.externalId,
    };
  });

/**
 * Opening balance plus every row must reach the closing balance. Shown live in
 * the preview and enforced on commit; null when the draft came from a CSV,
 * which prints no balances to check against.
 */
export const checkBankDraft = (draft: BankDraft): { ok: boolean; differenceEur: string } | null => {
  if (draft.statement === null) return null;
  const rows = bankRowsFromDraft(draft);
  const movement = rows.reduce((sum, row) => sum + row.amount, 0n);
  const opening = parseMoney(normaliseDecimal(draft.statement.openingBalanceEur), EUR).minor;
  const closing = parseMoney(normaliseDecimal(draft.statement.closingBalanceEur), EUR).minor;
  const difference = closing - (opening + movement);
  return {
    ok: difference === 0n,
    differenceEur: formatMoney({ minor: difference, currency: EUR }),
  };
};
```

Read `bank-statement.ts`'s `rowType` (near line 120) and use it instead of the local one if its signature fits (`rowType(label, amount, interestLabels)`); otherwise keep the local one and add a comment that a PDF row has no label column.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/server/import/bank-draft.test.ts`
Expected: all pass. If the `note` assertions differ from what `noteOf` produces, the test is what is wrong: fix the expected string to `noteOf`'s output, since the ledger's note format is `bank-statement.ts`'s, not this test's.

- [ ] **Step 5: Commit**

```bash
git add src/server/import/bank-draft.ts src/server/import/bank-draft.test.ts
git commit -m "feat(import): the bank statement as an editable draft with its balance check"
```

---

### Task 5: Bank preview returns the draft; commit takes it back

**Files:**

- Modify: `src/server/import/bank-service.ts`
- Modify: `src/web/server/bank-imports.ts`
- Modify: `src/server/import/bank-service.test.ts`
- Modify: `src/server/chat/runner.ts` — no change; `createClient` is reused.

**Interfaces:**

- Consumes: Task 3 `extractPages`, `readBankPdf`; Task 4 `BankDraft`, `bankDraftFromRows`, `bankDraftFromReading`, `bankRowsFromDraft`, `checkBankDraft`.
- Produces:
  - `previewBankStatement(userId, form)` → `{ bank: string; filename: string; sha256: string; draft: BankDraft; check: { ok, differenceEur } | null }`.
  - `CommitBankDraft` (zod): `{ accountId, filename: string, sha256: string, draft: BankDraft }`.
  - `commitBankDraft(userId, body: z.infer<typeof CommitBankDraft>)` → the same result shape `commitBankStatementUpload` returns today.
  - `_setReaderClient(client: ChatClient | null)` for tests.

- [ ] **Step 1: Rewrite the tests that touch preview and commit**

In `src/server/import/bank-service.test.ts`:

Replace `PreviewSchema` with:

```ts
const PreviewSchema = z.object({
  bank: z.string(),
  filename: z.string(),
  sha256: z.string(),
  draft: z.object({
    statement: z
      .object({
        from: z.string(),
        to: z.string(),
        openingBalanceEur: z.string(),
        closingBalanceEur: z.string(),
      })
      .nullable(),
    rows: z.array(
      z.object({ line: z.number(), date: z.string(), type: z.string(), amountEur: z.string() }),
    ),
    problems: z.array(z.object({ line: z.number(), text: z.string() })),
  }),
  check: z.object({ ok: z.boolean(), differenceEur: z.string() }).nullable(),
});
```

Replace the `commit` helper so a commit is "preview, then send the draft back":

```ts
const commit = async (userId: string, accountId: number, bytes?: ArrayBuffer) => {
  const previewed = await preview(userId, accountId, bytes);
  if (previewed.status !== 200) return previewed;
  const { filename, sha256, draft } = PreviewSchema.parse(previewed.body);
  return answer(() => bank.commitBankDraft(userId, { accountId, filename, sha256, draft }));
};
```

Every test that read `body.rows` as a count from the old preview now reads `body.draft.rows.length`; every one that read `sample` reads `draft.rows`. `verified` becomes `check !== null`. Go through the file and update those assertions.

The PDF tests (`describe("a PDF statement")` and `describe("importing several statements for one account")`) used the real fixtures through the OP parser. Give them a scripted reader instead. Add near the top:

```ts
let setReaderClient: BankService["_setReaderClient"];
// in beforeAll:
setReaderClient = bank._setReaderClient;

/** The model's reading of `op-statement-sample.pdf`, as the deleted parser produced it. */
const sampleReading = {
  from: "2025-08-28",
  to: "2026-08-28",
  openingBalance: "1500.00",
  closingBalance: "3236.44",
  maturityDate: null,
  rows: [
    {
      date: "2025-09-01",
      amount: "-25.90",
      counterparty: "K-MARKET ESIMERKKI",
      message: "PKORTTIMAKSU",
      reference: "20250901001",
    },
    {
      date: "2025-10-01",
      amount: "2750.00",
      counterparty: "TYÖNANTAJA OY",
      message: "PALKKA",
      reference: "20251001001",
    },
    {
      date: "2026-03-01",
      amount: "-1000.00",
      counterparty: "SÄÄSTÖTILI",
      message: "SIIRTO",
      reference: "20260301001",
    },
    {
      date: "2026-08-28",
      amount: "12.34",
      counterparty: "",
      message: "KORKO",
      reference: "20260828001",
    },
  ],
  problems: [],
};
const reader = (reading: unknown) => ({
  run: () => Promise.resolve({ text: JSON.stringify(reading), toolCalls: [] }),
});
```

Take the four rows' dates, amounts and references from the existing assertions in those describes (they assert `1574.10` as the balance after import, and the earlier statement's figures); keep the numbers the tests already expect and adjust the reading so `1500.00 + rows = 3236.44` holds, or the check refuses it. In each PDF test, call `setReaderClient(reader(sampleReading))` first, and for the "earlier statement" tests a second reading with the earlier period.

Add two new tests to `describe("a PDF statement")`:

```ts
test("an edited row is what gets imported, and the check runs on the edit", async () => {
  setReaderClient(reader(sampleReading));
  const { userId } = await signUp();
  const accountId = await openAccount(userId, "current");
  const previewed = PreviewSchema.parse((await preview(userId, accountId, await pdf())).body);
  const rows = previewed.draft.rows.map((row, index) =>
    index === 0 ? { ...row, amountEur: "-35.90" } : row,
  );
  const refused = await answer(() =>
    bank.commitBankDraft(userId, {
      accountId,
      filename: previewed.filename,
      sha256: previewed.sha256,
      draft: { ...previewed.draft, rows },
    }),
  );
  expect(refused.status).toBe(400);
  expect(ErrorSchema.parse(refused.body).error).toContain("10.00");
});

test("a draft with a field the schema does not know is refused", async () => {
  const { userId } = await signUp();
  const accountId = await openAccount(userId, "current");
  const status = await statusOf(() =>
    bank.commitBankDraft(userId, {
      accountId,
      filename: "x.pdf",
      sha256: "0",
      // SAFETY: the point is a shape the type forbids reaching the parser.
      draft: { statement: null, rows: [], problems: [], extra: 1 } as unknown as BankDraft,
    }),
  );
  expect(status).toBe(400);
});
```

`statusOf` does not exist in this file; add the one from `snapshot/service.test.ts` (`answer` then read `.status`), or use `(await answer(...)).status`. The `as unknown as BankDraft` chain is refused by `anti-slop/no-chained-type-assertions`: build the body with `JSON.parse('{"statement":null,"rows":[],"problems":[],"extra":1}')` instead, which is `any` without an assertion.

The pdf fixture helper:

```ts
const pdf = (): Promise<ArrayBuffer> =>
  readBytes(`${import.meta.dirname}/../import/fixtures/op-statement-sample.pdf`);
```

- [ ] **Step 2: Run the bank tests to see them fail**

Run: `pnpm vitest run src/server/import/bank-service.test.ts`
Expected: FAIL on `commitBankDraft is not a function` and the preview shape.

- [ ] **Step 3: Rewrite the service**

In `src/server/import/bank-service.ts`:

Replace the imports of `bank-pdf.ts` and `bank-pdf-sweep.ts` with:

```ts
import {
  BankDraft,
  bankDraftFromReading,
  bankDraftFromRows,
  bankRowsFromDraft,
  checkBankDraft,
} from "./bank-draft.ts";
import { extractPages, readBankPdf } from "./pdf-read.ts";
```

Replace `readStatement` with:

```ts
/**
 * Reads whichever format arrived into one draft. A CSV parses by its bank's
 * config; a PDF is read by the model, page by page. Neither is checked here:
 * the check belongs to the draft, which the owner may still edit.
 */
const readStatement = async (bytes: ArrayBuffer): Promise<{ bank: string; draft: BankDraft }> => {
  if (!isPdf(bytes)) {
    const config = detect(bytes);
    const { rows, problems } = parseBankStatement(bytes, config);
    return { bank: config.bank, draft: bankDraftFromRows(rows, problems) };
  }
  try {
    const pages = await extractPages(bytes);
    const reading = await readBankPdf(pages, readerClient ?? createClient());
    return { bank: "pdf", draft: bankDraftFromReading(reading) };
  } catch (cause) {
    // The extractor's and the reader's complaints are the owner's to act on --
    // a scanned file, a reply the schema refused -- so they arrive as 400s.
    throw asBadRequest(cause);
  }
};

/** Injected by tests, so a PDF never reaches the real model. */
let readerClient: ChatClient | null = null;
export const _setReaderClient = (client: ChatClient | null): void => {
  readerClient = client;
};
```

Replace `previewBankStatement`:

```ts
export const previewBankStatement = async (userId: string, form: FormData) => {
  const { file, accountId } = readUpload(form);
  await assertAccountOwned(userId, accountId);
  await assertBankAccount(accountId);

  const bytes = await file.arrayBuffer();
  const { bank, draft } = await readStatement(bytes);
  const sha256 = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
  return { bank, filename: file.name, sha256, draft, check: checkBankDraft(draft) };
};
```

Replace `commitBankStatementUpload` with `commitBankDraft`:

```ts
export const CommitBankDraft = z
  .object({
    accountId: z.number().int().positive(),
    filename: z.string().min(1).max(255),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    draft: BankDraft,
  })
  .strict();

/**
 * Commits the rows the owner reviewed -- and possibly corrected -- in the
 * preview. The file is not read again: the draft is the statement now.
 */
export const commitBankDraft = async (userId: string, body: z.infer<typeof CommitBankDraft>) => {
  const { accountId, filename, sha256, draft } = CommitBankDraft.parse(body);
  await assertAccountOwned(userId, accountId);
  await assertBankAccount(accountId);
  if (draft.rows.length === 0)
    throw new HttpError(400, "Tiedostosta ei löytynyt yhtään tapahtumaa");

  const check = checkBankDraft(draft);
  if (check !== null && !check.ok) {
    throw new HttpError(
      400,
      `Tiliotteen rivit eivät täsmää sen omaan loppusaldoon (ero ${check.differenceEur} €). ` +
        "Korjaa rivit esikatselussa ennen tuontia.",
    );
  }

  const rows = bankRowsFromDraft(draft);
  const result = await commitBankStatement(db, { userId, accountId, filename, sha256, rows });

  const statement = draft.statement === null ? null : statementOf(draft.statement);
  const reconciliation =
    statement === null ? null : await reconcileToStatement(db, accountId, statement);
  const maturity = statement === null ? null : await recordMaturity(db, accountId, statement);
  const classified = await classifyImportedSpending(db, userId, accountId);

  return {
    ...result,
    problems: draft.problems.map((problem) => ({ line: problem.line, message: problem.text })),
    reconciliation,
    classified,
    maturityDate: maturity?.maturityDate ?? null,
    maturityConflict: maturity?.maturityConflict ?? null,
  };
};
```

`reconcileToStatement` and `recordMaturity` take a `PdfStatement` from the deleted module. Define the shape they need locally and convert:

```ts
/** What the reconciliation and the maturity note read off a statement. */
type StatementFacts = {
  readonly from: string;
  readonly to: string;
  readonly openingBalance: Money;
  readonly closingBalance: Money;
  readonly maturityDate: string | null;
};

const statementOf = (statement: NonNullable<BankDraft["statement"]>): StatementFacts => ({
  from: statement.from,
  to: statement.to,
  openingBalance: parseMoney(statement.openingBalanceEur, EUR),
  closingBalance: parseMoney(statement.closingBalanceEur, EUR),
  maturityDate: statement.maturityDate,
});
```

Change the two functions' parameter type from `PdfStatement` to `StatementFacts`, and import `type Money` from `../../core/money.ts`.

In `src/web/server/bank-imports.ts` replace `commitBankImport`:

```ts
export const commitBankImport = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(CommitBankDraft)
  .handler(({ data, context }) => readable(() => commitBankDraft(context.userId, data)));
```

and import `CommitBankDraft, commitBankDraft` instead of `commitBankStatementUpload`.

- [ ] **Step 4: Typecheck and run the tests**

Run: `pnpm typecheck && pnpm vitest run src/server/import/bank-service.test.ts`
Expected: typecheck clean except `cash.tsx` calling `commitBankImport` with a `FormData` (fixed in Task 10; leave it), bank tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/import/bank-service.ts src/server/import/bank-service.test.ts src/web/server/bank-imports.ts
git commit -m "feat(import): bank preview is an editable draft, and commit takes it back"
```

---

### Task 6: Transaction drafts as wire bodies, and from a PDF reading

**Files:**

- Create: `src/server/import/txn-draft.ts`
- Test: `src/server/import/txn-draft.test.ts`

**Interfaces:**

- Consumes: `Draft`, `DraftTxn` from `map.ts`; `TransactionsReading` from Task 3; `parseMoney`, `parseQuantity`, `parseCurrency`, `EUR` from `core/money.ts`; `normaliseDate` from `map.ts`.
- Produces:
  - `DraftBody` (zod, strict): the JSON shape of `Draft` — `txns: DraftTxn[]` with every field, `problems`, `unknownIsins` — capped at 5000 rows.
  - `transactionsDraftFrom(reading: TransactionsReading, options: { accountId: number; knownIsins: ReadonlyMap<string, number>; knownNames: ReadonlyMap<string, number> }): Draft`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/import/txn-draft.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { DraftBody, transactionsDraftFrom } from "./txn-draft.ts";

const row = {
  date: "2025-01-10",
  type: "BUY" as const,
  name: "Nokia",
  isin: "FI0009000681",
  quantity: "100",
  unitPrice: "4,15",
  amount: "-418,00",
  fee: "3.00",
  tax: "0",
  currency: "EUR",
};

describe("transactionsDraftFrom", () => {
  test("maps a reading into draft rows in minor units, resolving the instrument by ISIN", () => {
    const draft = transactionsDraftFrom(
      { transactions: [row], problems: [] },
      { accountId: 7, knownIsins: new Map([["FI0009000681", 3]]), knownNames: new Map() },
    );
    expect(draft.txns[0]).toMatchObject({
      line: 1,
      accountId: 7,
      instrumentId: 3,
      isin: "FI0009000681",
      type: "BUY",
      tradeDate: "2025-01-10",
      quantity: 100_000_000,
      unitPrice: 415,
      amount: -41_800,
      fee: 300,
      tax: 0,
      currency: "EUR",
      fxRateEur: 100_000_000,
      externalId: null,
      note: "Nokia",
    });
    expect(draft.unknownIsins).toEqual([]);
  });

  test("a name-only row resolves by name, and an unknown one is listed, never invented", () => {
    const draft = transactionsDraftFrom(
      {
        transactions: [
          { ...row, isin: null, name: "OP-Maailma" },
          { ...row, isin: null, name: "Uusi rahasto" },
        ],
        problems: [],
      },
      { accountId: 7, knownIsins: new Map(), knownNames: new Map([["OP-MAAILMA", 5]]) },
    );
    expect(draft.txns.map((t) => t.instrumentId)).toEqual([5, null]);
    expect(draft.unknownIsins).toEqual([{ isin: null, name: "Uusi rahasto", currency: "EUR" }]);
  });

  test("a row the figures refuse becomes a problem carrying its text", () => {
    const draft = transactionsDraftFrom(
      { transactions: [{ ...row, amount: "paljon" }], problems: [{ line: 4, text: "rivi 4" }] },
      { accountId: 7, knownIsins: new Map(), knownNames: new Map() },
    );
    expect(draft.txns).toEqual([]);
    expect(draft.problems.map((p) => p.line)).toEqual([1, 4]);
    expect(draft.problems[1]).toMatchObject({ rawLine: "rivi 4" });
  });

  test("a non-EUR row is left for the commit to price", () => {
    const draft = transactionsDraftFrom(
      { transactions: [{ ...row, currency: "SEK" }], problems: [] },
      { accountId: 7, knownIsins: new Map(), knownNames: new Map() },
    );
    expect(draft.txns[0]?.fxRateEur).toBe(0);
  });
});

describe("DraftBody", () => {
  test("accepts exactly a Draft and nothing more", () => {
    const draft = transactionsDraftFrom(
      { transactions: [row], problems: [] },
      { accountId: 7, knownIsins: new Map(), knownNames: new Map() },
    );
    expect(DraftBody.parse(draft)).toEqual(draft);
    expect(DraftBody.safeParse({ ...draft, extra: 1 }).success).toBe(false);
    expect(
      DraftBody.safeParse({ ...draft, txns: [{ ...draft.txns[0], amount: "1" }] }).success,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run src/server/import/txn-draft.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the module**

Create `src/server/import/txn-draft.ts`:

```ts
import { z } from "zod";

import { EUR, parseCurrency, parseMoney, parseQuantity } from "../../core/money.ts";
import type { Draft, DraftTxn } from "./map.ts";
import type { TransactionsReading } from "./pdf-read.ts";

/**
 * A `Draft` as the browser sends it back after editing. Strict at every level:
 * a field the map never produced is a field the commit never expected.
 */
export const DraftBody = z
  .object({
    txns: z
      .array(
        z
          .object({
            line: z.number().int(),
            accountId: z.number().int().positive(),
            instrumentId: z.number().int().positive().nullable(),
            isin: z.string().nullable(),
            type: z.string().min(1),
            tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            quantity: z.number().int(),
            unitPrice: z.number().int().nullable(),
            amount: z.number().int(),
            fee: z.number().int(),
            tax: z.number().int(),
            currency: z.string().length(3).transform(parseCurrency),
            fxRateEur: z.number().int().nonnegative(),
            externalId: z.string().nullable(),
            note: z.string().nullable(),
          })
          .strict(),
      )
      .max(5000),
    problems: z.array(
      z
        .object({
          line: z.number().int(),
          message: z.string(),
          raw: z.record(z.string(), z.string()),
          rawLine: z.string().optional(),
        })
        .strict(),
    ),
    unknownIsins: z.array(
      z
        .object({
          isin: z.string().nullable(),
          name: z.string(),
          currency: z.string().length(3).transform(parseCurrency),
        })
        .strict(),
    ),
  })
  .strict();
export type DraftBody = z.infer<typeof DraftBody>;

const decimal = (text: string): string => text.replace(",", ".").replace(/\s/g, "");

/**
 * A model's reading into the draft the review screen and the commit already
 * understand. Rows that fail to parse become problems with their text, as
 * the CSV mapper does; instruments resolve by ISIN, then by name, and an
 * unresolved one is listed for the owner rather than invented.
 */
export const transactionsDraftFrom = (
  reading: TransactionsReading,
  options: {
    readonly accountId: number;
    readonly knownIsins: ReadonlyMap<string, number>;
    readonly knownNames: ReadonlyMap<string, number>;
  },
): Draft => {
  const txns: DraftTxn[] = [];
  const problems: Draft["problems"] = [];
  const unknown = new Map<string, Draft["unknownIsins"][number]>();
  const namesUpper = new Map([...options.knownNames].map(([name, id]) => [name.toUpperCase(), id]));

  reading.transactions.forEach((row, index) => {
    const line = index + 1;
    try {
      const currency = parseCurrency(row.currency.toUpperCase());
      const isin = row.isin?.trim() || null;
      const name = row.name.trim();
      const instrumentId = isin
        ? (options.knownIsins.get(isin) ?? null)
        : name !== ""
          ? (namesUpper.get(name.toUpperCase()) ?? null)
          : null;
      if (instrumentId === null && (isin !== null || name !== "")) {
        const key = isin ?? name;
        if (!unknown.has(key)) unknown.set(key, { isin, name, currency });
      }
      txns.push({
        line,
        accountId: options.accountId,
        instrumentId,
        isin,
        type: row.type,
        tradeDate: row.date,
        quantity: row.type === "DIVIDEND" ? 0 : Number(parseQuantity(decimal(row.quantity)).scaled),
        unitPrice:
          row.unitPrice === null || decimal(row.unitPrice) === "0"
            ? null
            : Number(parseMoney(decimal(row.unitPrice), currency).minor),
        amount: Number(parseMoney(decimal(row.amount), currency).minor),
        fee: Number(parseMoney(decimal(row.fee), currency).minor),
        tax: Number(parseMoney(decimal(row.tax), currency).minor),
        currency,
        fxRateEur: currency === EUR ? 100_000_000 : 0,
        externalId: null,
        note: name === "" ? null : name,
      });
    } catch (cause) {
      problems.push({
        line,
        message: cause instanceof Error ? cause.message : "Rivin käsittely epäonnistui",
        raw: { ...row, isin: row.isin ?? "", unitPrice: row.unitPrice ?? "" },
      });
    }
  });

  const fromReader = reading.problems.map((problem) => ({
    line: problem.line,
    message: "Mallia ei saanut riviä luettua",
    raw: {},
    rawLine: problem.text,
  }));

  return {
    txns,
    problems: [...problems, ...fromReader].sort((a, b) => a.line - b.line),
    unknownIsins: [...unknown.values()],
  };
};
```

`raw: { ...row, ... }` must be `Record<string, string>`; spread the row's string fields explicitly if the typecheck objects (`{ date: row.date, type: row.type, name: row.name, ... }`).

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/server/import/txn-draft.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/import/txn-draft.ts src/server/import/txn-draft.test.ts
git commit -m "feat(import): transaction drafts from a PDF reading, and as a validated body"
```

---

### Task 7: Tuonnit preview reads PDFs; commit takes the draft

**Files:**

- Modify: `src/server/import/service.ts`
- Modify: `src/web/server/imports.ts`
- Modify: `src/server/import/service.test.ts`

**Interfaces:**

- Consumes: Task 3 `extractPages`, `readTransactionsPdf`; Task 6 `DraftBody`, `transactionsDraftFrom`; `createClient` from the runner.
- Produces:
  - `previewUpload` unchanged in shape (`{ broker, filename, sha256, ...draft }`); `broker` is `"pdf"` for a PDF.
  - `CommitDraftBody` (zod, strict): `{ accountId, filename, sha256, kind: "csv_nordnet" | "csv_op" | "pdf", draft: DraftBody }`.
  - `commitDraftBody(userId, body)` → `CommitResult`.
  - `_setReaderClient(client)` for tests.
  - `commitUpload` and `commitPaste` are deleted; the server functions `commitImport` and `commitOpPaste` become one: `commitImport` validated with `CommitDraftBody`.

- [ ] **Step 1: Update the service tests**

In `src/server/import/service.test.ts`, every commit test currently calls `service.commitUpload(userId, uploadForm(...))` or `service.commitPaste(...)`. Add a helper next to `answer`:

```ts
/** Preview, then commit what the preview produced -- the path the screen takes. */
const commitPreviewed = async (
  userId: string,
  previewed: Answer<unknown>,
  accountId: number,
  kind: "csv_nordnet" | "csv_op" | "pdf",
) => {
  if (previewed.status !== 200) return previewed;
  // SAFETY: a 200 from either preview is `{ broker, filename, sha256, txns, problems, unknownIsins }`.
  const body = previewed.body as {
    filename: string;
    sha256: string;
    txns: unknown[];
    problems: unknown[];
    unknownIsins: unknown[];
  };
  return answer(() =>
    service.commitDraftBody(userId, {
      accountId,
      filename: body.filename,
      sha256: body.sha256,
      kind,
      draft: { txns: body.txns, problems: body.problems, unknownIsins: body.unknownIsins },
    }),
  );
};
```

The `as` needs its `SAFETY` comment (present). Replace each `commitUpload` call with `commitPreviewed(userId, await answer(() => service.previewUpload(userId, uploadForm(...))), accountId, "csv_nordnet")` and each `commitPaste` with the same over `previewPaste` and `"csv_op"`. Keep the assertions.

Add a describe for the PDF path:

```ts
describe("a broker PDF", () => {
  const reading = {
    transactions: [
      {
        date: "2025-01-10",
        type: "BUY",
        name: "NOKIA",
        isin: "FI0009000681",
        quantity: "100",
        unitPrice: "4.15",
        amount: "-418.00",
        fee: "3.00",
        tax: "0",
        currency: "EUR",
      },
    ],
    problems: [],
  };

  test("previews through the reader and commits like any draft", async () => {
    service._setReaderClient({
      run: () => Promise.resolve({ text: JSON.stringify(reading), toolCalls: [] }),
    });
    const { userId } = await signUp(`imp-pdf-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId);
    await registerNokia();
    const bytes = await readBytes(`${import.meta.dirname}/fixtures/op-statement-sample.pdf`);
    const form = new FormData();
    form.set("file", new File([bytes], "tapahtumat.pdf"));
    form.set("accountId", String(accountId));

    const previewed = await answer(() => service.previewUpload(userId, form));
    expect(previewed.status).toBe(200);
    // SAFETY: a 200 preview carries the draft.
    expect((previewed.body as { broker: string; txns: unknown[] }).broker).toBe("pdf");

    const committed = await commitPreviewed(userId, previewed, accountId, "pdf");
    expect(committed.status).toBe(200);
    // SAFETY: a 200 commit reports counts.
    expect((committed.body as { inserted: number }).inserted).toBe(1);
  });

  test("an edited draft is what commits", async () => {
    service._setReaderClient({
      run: () => Promise.resolve({ text: JSON.stringify(reading), toolCalls: [] }),
    });
    const { userId } = await signUp(`imp-pdf-edit-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId);
    await registerNokia();
    const bytes = await readBytes(`${import.meta.dirname}/fixtures/op-statement-sample.pdf`);
    const form = new FormData();
    form.set("file", new File([bytes], "tapahtumat.pdf"));
    form.set("accountId", String(accountId));
    const previewed = await answer(() => service.previewUpload(userId, form));
    // SAFETY: a 200 preview carries the draft.
    const body = previewed.body as {
      filename: string;
      sha256: string;
      txns: Array<Record<string, unknown>>;
      problems: unknown[];
      unknownIsins: unknown[];
    };
    const edited = { ...body, txns: [{ ...body.txns[0], amount: -50_000 }] };
    const committed = await commitPreviewed(
      userId,
      { status: 200, body: edited },
      accountId,
      "pdf",
    );
    expect(committed.status).toBe(200);
    const stored = await db.select().from(transactions).all();
    expect(stored.at(-1)?.amount).toBe(-50_000);
  });
});
```

Check what `registerNokia`, `openAccount`, `signUp`, `db` and `transactions` are called in this file (they exist; the earlier tests use them) and match the names.

- [ ] **Step 2: Run the service tests to see them fail**

Run: `pnpm vitest run src/server/import/service.test.ts`
Expected: FAIL on `commitDraftBody`/`_setReaderClient` missing.

- [ ] **Step 3: Rewrite the service's commit and PDF preview**

In `src/server/import/service.ts`:

Add imports:

```ts
import { createClient, type ChatClient } from "../chat/runner.ts";
import { extractPages, readTransactionsPdf } from "./pdf-read.ts";
import { DraftBody, transactionsDraftFrom } from "./txn-draft.ts";
```

Add after `knownInstrumentMaps`:

```ts
const isPdf = (bytes: ArrayBuffer): boolean =>
  new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";

/** Injected by tests, so a PDF never reaches the real model. */
let readerClient: ChatClient | null = null;
export const _setReaderClient = (client: ChatClient | null): void => {
  readerClient = client;
};

const buildPdfDraft = async (bytes: ArrayBuffer, accountId: number) => {
  let draft: Draft;
  try {
    const pages = await extractPages(bytes);
    const reading = await readTransactionsPdf(pages, readerClient ?? createClient());
    const { knownIsins, knownNames } = await knownInstrumentMaps();
    draft = transactionsDraftFrom(reading, { accountId, knownIsins, knownNames });
  } catch (cause) {
    throw new HttpError(
      400,
      cause instanceof Error ? cause.message : "PDF-tiedostoa ei voitu lukea",
    );
  }
  return draft;
};
```

Change `buildDraft` to branch on `isPdf(bytes)` first:

```ts
const buildDraft = async (file: File, accountId: number) => {
  const bytes = await file.arrayBuffer();
  const sha256 = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
  if (isPdf(bytes)) {
    return { broker: "pdf" as const, draft: await buildPdfDraft(bytes, accountId), sha256 };
  }
  const config = detectBrokerConfig(bytes);
  if (!config) throw new HttpError(400, "Tuntematon CSV-muoto: välittäjää ei tunnistettu");
  ... (existing body, returning { broker: config.broker, draft, sha256 })
};
```

and update `previewUpload` to `{ broker, filename, sha256, ...draft }` from that.

Delete `commitUpload` and `commitPaste`. Add:

```ts
export const CommitDraftBody = z
  .object({
    accountId: z.number().int().positive(),
    filename: z.string().min(1).max(255),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    kind: z.enum(["csv_nordnet", "csv_op", "pdf"]),
    draft: DraftBody,
  })
  .strict();

/**
 * Commits the draft the owner reviewed in the preview -- edits included. The
 * file is not read again; the draft is what enters the ledger. `accountId`
 * on every row is overwritten with the one the request names, so an edited
 * row cannot point at someone else's account.
 */
export const commitDraftBody = async (userId: string, body: z.infer<typeof CommitDraftBody>) => {
  const { accountId, filename, sha256, kind, draft } = CommitDraftBody.parse(body);
  await assertAccountOwned(userId, accountId);
  const owned: Draft = { ...draft, txns: draft.txns.map((txn) => ({ ...txn, accountId })) };
  const result = await commitDraft(db, { userId, accountId, filename, sha256, draft: owned, kind });
  fireBackfill(owned);
  return result;
};
```

`commitDraft`'s `kind` is `ImportKind`, which already includes `"pdf"`.

In `src/web/server/imports.ts`, replace `commitImport` and `commitOpPaste` with one:

```ts
export const commitImport = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(CommitDraftBody)
  .handler(({ data, context }) => readable(() => commitDraftBody(context.userId, data)));
```

importing `CommitDraftBody, commitDraftBody` and dropping `commitPaste, commitUpload`.

- [ ] **Step 4: Typecheck and run**

Run: `pnpm typecheck; pnpm vitest run src/server/import`
Expected: the only type errors are in `imports.tsx` (Task 11). Import tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/import/service.ts src/server/import/service.test.ts src/web/server/imports.ts
git commit -m "feat(import): read broker PDFs, and commit the reviewed draft rather than the file"
```

---

### Task 8: Holdings from a PDF, and the total check

**Files:**

- Create: `src/server/snapshot/holdings-draft.ts`
- Modify: `src/server/snapshot/service.ts`
- Modify: `src/web/server/snapshots.ts`
- Test: `src/server/snapshot/holdings-draft.test.ts`, `src/server/snapshot/service.test.ts`

**Interfaces:**

- Consumes: Task 3 `extractPages`, `readHoldingsPdf`; `proposalFrom` (make it exported from `service.ts`, or move its body); `createClient`.
- Produces:
  - `holdingsTotalCheck(rows: readonly { marketValueEur: string }[], statedTotalEur: string | null): { ok: boolean; differenceEur: string } | null`
  - `proposeFromPdf(userId, form: FormData)` → same shape as `proposeFromCsv` plus `statedTotalEur: string | null`, `filename`, and `source: "pdf"`.
  - `CreateSnapshot` gains `statedTotalEur: z.string().nullable().optional()`; `createSnapshot` refuses with 400 when rows' values do not sum to it.
  - `_setReaderClient(client)`.

- [ ] **Step 1: Write the failing tests**

Create `src/server/snapshot/holdings-draft.test.ts`:

```ts
import { expect, test } from "vitest";

import { holdingsTotalCheck } from "./holdings-draft.ts";

test("the rows' values must reach the printed total, to the cent", () => {
  const rows = [{ marketValueEur: "40.00" }, { marketValueEur: "960,00" }];
  expect(holdingsTotalCheck(rows, "1000.00")).toEqual({ ok: true, differenceEur: "0.00" });
  expect(holdingsTotalCheck(rows, "1001.00")).toEqual({ ok: false, differenceEur: "1.00" });
});

test("no printed total, nothing to check", () => {
  expect(holdingsTotalCheck([{ marketValueEur: "1.00" }], null)).toBeNull();
});
```

In `src/server/snapshot/service.test.ts` add:

```ts
describe("a holdings PDF", () => {
  test("proposes rows through the reader, matched by name, with the printed total", async () => {
    service._setReaderClient({
      run: () =>
        Promise.resolve({
          text: JSON.stringify({
            asOf: "2026-06-30",
            totalValue: "1000.00",
            holdings: [
              {
                name: "Nokia",
                isin: null,
                quantity: "10",
                marketValue: "1000.00",
                currency: "EUR",
              },
            ],
            problems: [],
          }),
          toolCalls: [],
        }),
    });
    const { userId } = await signUp(`snap-pdf-${crypto.randomUUID()}@example.com`);
    const nokia = await addInstrument(db, {
      isin: "FI0009000681",
      name: "Nokia",
      kind: "stock",
      currency: EUR,
      priceSource: "manual",
      sourceKey: null,
    });
    const form = new FormData();
    form.set(
      "file",
      new File(
        [await readBytes(`${import.meta.dirname}/../import/fixtures/op-statement-sample.pdf`)],
        "ote.pdf",
      ),
    );
    const proposed = await answer(() => service.proposeFromPdf(userId, form));
    expect(proposed.status).toBe(200);
    expect(proposed.body).toMatchObject({
      asOf: "2026-06-30",
      statedTotalEur: "1000.00",
      rows: [{ name: "Nokia", instrumentId: nokia.id, quantity: "10", marketValueEur: "1000.00" }],
    });
  });

  test("saving refuses rows that do not reach the total the statement printed", async () => {
    const { userId } = await signUp(`snap-total-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId);
    const nokia = await addInstrument(db, {
      isin: "FI0009000681",
      name: "Nokia",
      kind: "stock",
      currency: EUR,
      priceSource: "manual",
      sourceKey: null,
    });
    const refused = await answer(() =>
      service.createSnapshot(userId, {
        accountId,
        asOf: "2026-06-30",
        source: "pdf",
        statedTotalEur: "1000.00",
        rows: [{ instrumentId: nokia.id, quantity: "10", marketValue: "900.00" }],
      }),
    );
    expect(refused.status).toBe(400);
  });
});
```

Match `addInstrument`'s real signature (`src/server/instruments/store.ts`) and this file's `openAccount` helper; `readBytes` comes from `../files.ts`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run src/server/snapshot`
Expected: FAIL on the missing module and functions.

- [ ] **Step 3: Write the check and the proposal**

Create `src/server/snapshot/holdings-draft.ts`:

```ts
import { EUR, formatMoney, parseMoney } from "../../core/money.ts";

const decimal = (text: string): string => text.replace(",", ".").replace(/\s/g, "");

/**
 * A statement that prints its total lets the rows be checked against it, the
 * way a bank statement's balances check its rows. Null when nothing was printed.
 */
export const holdingsTotalCheck = (
  rows: readonly { readonly marketValueEur: string }[],
  statedTotalEur: string | null,
): { ok: boolean; differenceEur: string } | null => {
  if (statedTotalEur === null) return null;
  const sum = rows.reduce(
    (total, row) => total + parseMoney(decimal(row.marketValueEur), EUR).minor,
    0n,
  );
  const stated = parseMoney(decimal(statedTotalEur), EUR).minor;
  const difference = stated - sum;
  return {
    ok: difference === 0n,
    differenceEur: formatMoney({ minor: difference, currency: EUR }),
  };
};
```

In `src/server/snapshot/service.ts`:

- Add `statedTotalEur: z.string().nullable().optional()` to `CreateSnapshot`.
- In `createSnapshot`, after the unknown-instrument check:

```ts
const check = holdingsTotalCheck(
  input.rows.map((row) => ({ marketValueEur: row.marketValue ?? "0" })),
  input.statedTotalEur ?? null,
);
if (check !== null && !check.ok) {
  throw new HttpError(
    400,
    `Rivien arvot eivät täsmää otteen kokonaisarvoon (ero ${check.differenceEur} €). Korjaa rivit ennen tallennusta.`,
  );
}
```

- Add the reader and the PDF proposal:

```ts
/** Injected by tests, so a PDF never reaches the real model. */
let readerClient: ChatClient | null = null;
export const _setReaderClient = (client: ChatClient | null): void => {
  readerClient = client;
};

/**
 * Proposes a snapshot from a holdings statement PDF, read by the model. The
 * statement's own date and printed total come with it; the owner edits and
 * confirms through `createSnapshot`, which checks the total again.
 */
export const proposeFromPdf = async (userId: string, form: FormData) => {
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "Tiedosto puuttuu");
  try {
    const pages = await extractPages(await file.arrayBuffer());
    const reading = await readHoldingsPdf(pages, readerClient ?? createClient());
    const proposal = await proposalFrom(userId, reading.asOf, {
      holdings: reading.holdings.map((h) => ({
        name: h.name,
        quantity: h.quantity.replace(",", "."),
        marketValueEur: h.marketValue.replace(",", "."),
      })),
      problems: reading.problems.map((p) => ({
        line: p.line,
        message: "Riviä ei saatu luettua",
        raw: p.text,
      })),
    });
    return {
      ...proposal,
      statedTotalEur: reading.totalValue,
      filename: file.name,
      source: "pdf" as const,
    };
  } catch (cause) {
    if (cause instanceof HttpError) throw cause;
    throw new HttpError(
      400,
      cause instanceof Error ? cause.message : "PDF-tiedostoa ei voitu lukea",
    );
  }
};
```

with imports `import { createClient, type ChatClient } from "../chat/runner.ts";`, `import { extractPages, readHoldingsPdf } from "../import/pdf-read.ts";`, `import { holdingsTotalCheck } from "./holdings-draft.ts";`. Non-EUR holdings: the reading's `currency` is carried into the proposal row as `currency` so the screen can show it; the total check is on EUR values only, as the CSV path is today.

In `src/web/server/snapshots.ts` add:

```ts
export const proposeSnapshotFromPdf = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(z.instanceof(FormData))
  .handler(({ data, context }) => readable(() => proposeFromPdf(context.userId, data)));
```

- [ ] **Step 4: Run**

Run: `pnpm typecheck && pnpm vitest run src/server/snapshot`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/snapshot src/web/server/snapshots.ts
git commit -m "feat(snapshot): propose a holdings statement from a PDF, checked against its total"
```

---

### Task 9: Draft editing helpers

**Files:**

- Create: `src/web/routes/draft-edit.ts`
- Test: `src/web/routes/draft-edit.test.ts`

**Interfaces:**

- Produces (all pure, all return new arrays):
  - `updateRow<T>(rows: readonly T[], index: number, patch: Partial<T>): T[]`
  - `removeRow<T>(rows: readonly T[], index: number): T[]`
  - `appendRow<T>(rows: readonly T[], blank: T): T[]`
  - `bankBalanceCheck(draft: { statement: { openingBalanceEur: string; closingBalanceEur: string } | null; rows: readonly { amountEur: string }[] }): { ok: boolean; differenceEur: string } | null` — the browser-side twin of `checkBankDraft`, on decimal strings with `Number` arithmetic in cents (`Math.round(x * 100)`).
  - `holdingsTotalCheck(rows: readonly { marketValueEur: string }[], statedTotalEur: string | null)` — same, for values.
  - `problemToRow(problem: { line: number; text: string }): { line: number; date: string; type: "DEPOSIT"; amountEur: string; counterparty: string; message: string; externalId: null }` — a blank bank row that keeps the printed text in `message` for the owner to replace.

- [ ] **Step 1: Write the failing tests**

Create `src/web/routes/draft-edit.test.ts`:

```ts
import { expect, test } from "vitest";

import {
  appendRow,
  bankBalanceCheck,
  holdingsTotalCheck,
  removeRow,
  updateRow,
} from "./draft-edit.ts";

test("row edits return new arrays and leave the input alone", () => {
  const rows = [{ a: 1 }, { a: 2 }];
  expect(updateRow(rows, 1, { a: 3 })).toEqual([{ a: 1 }, { a: 3 }]);
  expect(removeRow(rows, 0)).toEqual([{ a: 2 }]);
  expect(appendRow(rows, { a: 9 })).toEqual([{ a: 1 }, { a: 2 }, { a: 9 }]);
  expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
});

test("the balance check follows the edit, in cents, and tolerates a decimal comma", () => {
  const draft = {
    statement: { openingBalanceEur: "1500,00", closingBalanceEur: "1474.10" },
    rows: [{ amountEur: "-25.90" }],
  };
  expect(bankBalanceCheck(draft)).toEqual({ ok: true, differenceEur: "0.00" });
  expect(bankBalanceCheck({ ...draft, rows: [{ amountEur: "-35.90" }] })).toEqual({
    ok: false,
    differenceEur: "10.00",
  });
  expect(bankBalanceCheck({ ...draft, rows: [{ amountEur: "paljon" }] })).toEqual({
    ok: false,
    differenceEur: "?",
  });
  expect(bankBalanceCheck({ statement: null, rows: [] })).toBeNull();
});

test("the holdings total check does the same for values", () => {
  expect(
    holdingsTotalCheck([{ marketValueEur: "40" }, { marketValueEur: "960" }], "1000.00"),
  ).toEqual({ ok: true, differenceEur: "0.00" });
  expect(holdingsTotalCheck([{ marketValueEur: "40" }], null)).toBeNull();
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run src/web/routes/draft-edit.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the helpers**

Create `src/web/routes/draft-edit.ts`:

```ts
/**
 * Editing a preview in the browser. Pure, so the screens stay thin and this
 * can be tested without a DOM; the server re-validates and re-checks every
 * draft it is sent, so nothing here is the last line of defence.
 */

export const updateRow = <T>(rows: readonly T[], index: number, patch: Partial<T>): T[] =>
  rows.map((row, at) => (at === index ? { ...row, ...patch } : row));

export const removeRow = <T>(rows: readonly T[], index: number): T[] =>
  rows.filter((_, at) => at !== index);

export const appendRow = <T>(rows: readonly T[], blank: T): T[] => [...rows, blank];

/** Cents from a decimal string as typed, or null when it is not a number yet. */
const cents = (text: string): number | null => {
  const value = Number(text.replace(",", ".").replace(/\s/g, ""));
  return Number.isFinite(value) ? Math.round(value * 100) : null;
};

const formatCents = (value: number): string => (value / 100).toFixed(2);

type Check = { readonly ok: boolean; readonly differenceEur: string };

const sumCents = (texts: readonly string[]): number | null =>
  texts.reduce<number | null>((sum, text) => {
    const value = cents(text);
    return sum === null || value === null ? null : sum + value;
  }, 0);

/**
 * Opening balance plus rows against the closing balance, recomputed on every
 * keystroke. A row that is not a number yet shows "?" rather than a wrong
 * figure. Null for a CSV, which prints no balances.
 */
export const bankBalanceCheck = (draft: {
  readonly statement: {
    readonly openingBalanceEur: string;
    readonly closingBalanceEur: string;
  } | null;
  readonly rows: readonly { readonly amountEur: string }[];
}): Check | null => {
  if (draft.statement === null) return null;
  const opening = cents(draft.statement.openingBalanceEur);
  const closing = cents(draft.statement.closingBalanceEur);
  const movement = sumCents(draft.rows.map((row) => row.amountEur));
  if (opening === null || closing === null || movement === null)
    return { ok: false, differenceEur: "?" };
  const difference = closing - (opening + movement);
  return { ok: difference === 0, differenceEur: formatCents(difference) };
};

export const holdingsTotalCheck = (
  rows: readonly { readonly marketValueEur: string }[],
  statedTotalEur: string | null,
): Check | null => {
  if (statedTotalEur === null) return null;
  const stated = cents(statedTotalEur);
  const sum = sumCents(rows.map((row) => row.marketValueEur));
  if (stated === null || sum === null) return { ok: false, differenceEur: "?" };
  const difference = stated - sum;
  return { ok: difference === 0, differenceEur: formatCents(difference) };
};

/** A problem the reader reported, as a row to fill in; the printed text stays visible until replaced. */
export const problemToRow = (problem: { readonly line: number; readonly text: string }) => ({
  line: problem.line,
  date: "",
  type: "DEPOSIT" as const,
  amountEur: "",
  counterparty: "",
  message: problem.text,
  externalId: null,
});
```

- [ ] **Step 4: Run**

Run: `pnpm vitest run src/web/routes/draft-edit.test.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/web/routes/draft-edit.ts src/web/routes/draft-edit.test.ts
git commit -m "feat(web): pure helpers for editing an import preview"
```

---

### Task 10: The editable table, and the cash screen

**Files:**

- Create: `src/web/routes/DraftTable.tsx`
- Modify: `src/web/routes/cash.tsx`

**Interfaces:**

- Consumes: Task 9 helpers; Task 5 preview/commit shapes via `previewBankImport` / `commitBankImport`.
- Produces: `DraftTable<T extends { line: number }>` with props `{ rows: readonly T[]; columns: readonly Column<T>[]; onChange: (rows: T[]) => void; blank: () => T; fieldErrors?: Record<number, string> }` where `Column<T> = { key: keyof T & string; label: string; kind: "text" | "date" | "decimal" | { options: readonly { value: string; label: string }[] }; numeric?: boolean }`.

- [ ] **Step 1: Write the component**

Create `src/web/routes/DraftTable.tsx`:

```tsx
import { appendRow, removeRow, updateRow } from "./draft-edit.ts";

export type Column<T> = {
  readonly key: keyof T & string;
  readonly label: string;
  readonly kind:
    "text" | "date" | "decimal" | { readonly options: readonly { value: string; label: string }[] };
  readonly numeric?: boolean;
};

/**
 * An import preview as a table of inputs. Every cell edits its row in place,
 * a row can go, and a blank one can be added at the end. What the owner sees
 * is what will be committed; the server validates it again on the way in.
 */
export const DraftTable = <T extends { readonly line: number }>({
  rows,
  columns,
  onChange,
  blank,
  fieldErrors = {},
}: {
  readonly rows: readonly T[];
  readonly columns: readonly Column<T>[];
  readonly onChange: (rows: T[]) => void;
  readonly blank: () => T;
  /** Server-side complaints keyed by line, shown under the row they name. */
  readonly fieldErrors?: Record<number, string>;
}) => (
  <div className="grid gap-2">
    <div className="max-h-112 overflow-auto rounded border border-line">
      <table>
        <thead className="sticky top-0 bg-surface">
          <tr>
            <th>Rivi</th>
            {columns.map((column) => (
              <th key={column.key} className={column.numeric ? "num" : undefined}>
                {column.label}
              </th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.line}-${index}`}>
              <td className="num">{row.line}</td>
              {columns.map((column) => {
                const value = String(row[column.key] ?? "");
                const set = (next: string) =>
                  // SAFETY: every column edits a string field of T; `key` is
                  // `keyof T`, and the value typed into an input is a string.
                  onChange(updateRow(rows, index, { [column.key]: next } as Partial<T>));
                return (
                  <td key={column.key} className={column.numeric ? "num" : undefined}>
                    {typeof column.kind === "object" ? (
                      <select value={value} onChange={(e) => set(e.target.value)}>
                        {column.kind.options.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={column.kind === "date" ? "date" : "text"}
                        inputMode={column.kind === "decimal" ? "decimal" : undefined}
                        value={value}
                        onChange={(e) => set(e.target.value)}
                      />
                    )}
                  </td>
                );
              })}
              <td>
                <button
                  type="button"
                  className="text-sm"
                  onClick={() => onChange(removeRow(rows, index))}
                >
                  Poista
                </button>
                {fieldErrors[row.line] !== undefined && (
                  <p role="alert" className="text-loss text-xs">
                    {fieldErrors[row.line]}
                  </p>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <button type="button" className="text-sm" onClick={() => onChange(appendRow(rows, blank()))}>
      + Lisää rivi
    </button>
  </div>
);
```

The `as Partial<T>` is one assertion with its `SAFETY` line; the lint rule accepts that.

- [ ] **Step 2: Rewrite the cash screen's import section**

In `src/web/routes/cash.tsx`:

State replaces `preview.data` reading: keep `files`, add

```ts
type BankPreview = Awaited<ReturnType<typeof previewBankImport>>;
const [drafts, setDrafts] = useState<{ name: string; preview: BankPreview }[]>([]);
```

`preview` mutation's `onSuccess` sets `drafts` from the per-file results (`{ name: file.name, preview: data }`), including the reader's problems appended as rows via `problemToRow`. `commit` iterates `drafts`, calling:

```ts
commitBankImport({
  data: {
    accountId: chosen ?? 0,
    filename: entry.preview.filename,
    sha256: entry.preview.sha256,
    draft: { ...entry.preview.draft, rows: entry.preview.draft.rows, problems: [] },
  },
});
```

with the same one-file-at-a-time loop and `imported` results as today. `problems` is sent empty because the screen has turned every problem into a row.

Render each draft as:

```tsx
{
  drafts.map((entry, index) => {
    const check = bankBalanceCheck(entry.preview.draft);
    return (
      <div key={`${index}-${entry.name}`} className="grid gap-2">
        {drafts.length > 1 && <h3>{entry.name}</h3>}
        {entry.preview.draft.statement && (
          <p className="text-muted text-sm">
            Tiliote {fiDate(entry.preview.draft.statement.from)}–
            {fiDate(entry.preview.draft.statement.to)}, saldo{" "}
            {eur(entry.preview.draft.statement.openingBalanceEur)} →{" "}
            {eur(entry.preview.draft.statement.closingBalanceEur)}.
          </p>
        )}
        {check !== null && (
          <p className={check.ok ? "text-gain text-sm" : "text-loss text-sm"}>
            {check.ok
              ? "Rivit täsmäävät loppusaldoon."
              : `Rivit eivät täsmää loppusaldoon: ero ${check.differenceEur} €.`}
          </p>
        )}
        <DraftTable
          rows={entry.preview.draft.rows}
          columns={BANK_COLUMNS}
          blank={() => ({
            line: entry.preview.draft.rows.length + 1,
            date: "",
            type: "DEPOSIT",
            amountEur: "",
            counterparty: "",
            message: "",
            externalId: null,
          })}
          onChange={(rows) =>
            setDrafts((current) =>
              current.map((d, at) =>
                at === index
                  ? { ...d, preview: { ...d.preview, draft: { ...d.preview.draft, rows } } }
                  : d,
              ),
            )
          }
        />
      </div>
    );
  });
}
```

with

```ts
const BANK_COLUMNS: readonly Column<BankPreview["draft"]["rows"][number]>[] = [
  { key: "date", label: "Päivä", kind: "date" },
  {
    key: "type",
    label: "Laji",
    kind: {
      options: [
        { value: "DEPOSIT", label: "Pano" },
        { value: "WITHDRAWAL", label: "Otto" },
        { value: "INTEREST", label: "Korko" },
      ],
    },
  },
  { key: "amountEur", label: "Summa", kind: "decimal", numeric: true },
  { key: "counterparty", label: "Vastapuoli", kind: "text" },
  { key: "message", label: "Viesti", kind: "text" },
];
```

The "Tuo" button is disabled while any draft's `check` is `{ ok: false }`. Remove the old `sample` rendering. Keep the `imported` results block.

- [ ] **Step 3: Typecheck, lint, build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: clean. If `BankPreview["draft"]["rows"][number]` does not resolve because the server function's return type is wrapped, derive it from `BankDraft` instead: `import type { BankDraft } from "../../server/import/bank-draft.ts"` and use `BankDraft["rows"][number]`.

- [ ] **Step 4: Commit**

```bash
git add src/web/routes/DraftTable.tsx src/web/routes/cash.tsx
git commit -m "feat(web): edit a bank statement in the preview before importing it"
```

---

### Task 11: Tuonnit edits its drafts

**Files:**

- Modify: `src/web/routes/imports.tsx`
- Modify: `src/web/routes/imports-draft.ts` (the `DraftResponse` type gains `accountId`, `instrumentId`, `unitPrice`, `fee`, `tax`, `fxRateEur`, `externalId`, `note` on `txns` so the draft round-trips)
- Modify: `src/web/routes/imports.test.ts` if `summarise`'s fixtures need the new fields (they use a `txnStub`; extend it).

**Interfaces:**

- Consumes: Task 7 `commitImport({ data: CommitDraftBody })`; Task 10 `DraftTable`.

- [ ] **Step 1: Widen the draft type**

In `src/web/routes/imports-draft.ts`, replace `DraftResponse["txns"]`'s element type with every `DraftTxn` field:

```ts
txns: Array<{
  line: number;
  accountId: number;
  instrumentId: number | null;
  isin: string | null;
  type: string;
  tradeDate: string;
  quantity: number;
  unitPrice: number | null;
  amount: number;
  fee: number;
  tax: number;
  currency: string;
  fxRateEur: number;
  externalId: string | null;
  note: string | null;
}>;
```

and extend `txnStub` in `imports.test.ts` with the new fields (`accountId: 1, instrumentId: null, unitPrice: null, fee: 0, tax: 0, fxRateEur: 100_000_000, externalId: null, note: null`).

- [ ] **Step 2: Edit rows on screen, in euros**

Amounts in `DraftTxn` are minor-unit integers; the table edits strings. In `imports.tsx` add two converters next to `importSummary`:

```ts
/** A draft row as the table edits it: money and quantity as decimal strings. */
type EditableTxn = {
  line: number;
  tradeDate: string;
  type: string;
  isin: string;
  quantityText: string;
  amountEur: string;
  feeEur: string;
  currency: string;
  note: string;
};
const toEditable = (txn: DraftResponse["txns"][number]): EditableTxn => ({
  line: txn.line,
  tradeDate: txn.tradeDate,
  type: txn.type,
  isin: txn.isin ?? "",
  quantityText: (txn.quantity / 1_000_000).toString(),
  amountEur: minorToEur(txn.amount),
  feeEur: minorToEur(txn.fee),
  currency: txn.currency,
  note: txn.note ?? "",
});
const fromEditable = (
  row: EditableTxn,
  base: DraftResponse["txns"][number] | undefined,
  accountId: number,
): DraftResponse["txns"][number] => ({
  line: row.line,
  accountId,
  instrumentId: base?.instrumentId ?? null,
  isin: row.isin === "" ? null : row.isin,
  type: row.type,
  tradeDate: row.tradeDate,
  quantity: Math.round(Number(row.quantityText.replace(",", ".")) * 1_000_000),
  unitPrice: base?.unitPrice ?? null,
  amount: Math.round(Number(row.amountEur.replace(",", ".")) * 100),
  fee: Math.round(Number(row.feeEur.replace(",", ".")) * 100),
  tax: base?.tax ?? 0,
  currency: row.currency,
  fxRateEur: row.currency === "EUR" ? 100_000_000 : 0,
  externalId: base?.externalId ?? null,
  note: row.note === "" ? null : row.note,
});
```

`Previewed` gains `rows: EditableTxn[]`, filled with `draft.txns.map(toEditable)` in `showPreviews`. `PreviewCard` takes `rows` and an `onRows` callback and renders `DraftTable` with:

```ts
const TXN_COLUMNS: readonly Column<EditableTxn>[] = [
  { key: "tradeDate", label: "Päivä", kind: "date" },
  {
    key: "type",
    label: "Laji",
    kind: {
      options: [
        "BUY",
        "SELL",
        "DIVIDEND",
        "DEPOSIT",
        "WITHDRAWAL",
        "FEE",
        "TRANSFER_IN",
        "TRANSFER_OUT",
        "INTEREST",
      ].map((value) => ({ value, label: value })),
    },
  },
  { key: "isin", label: "ISIN", kind: "text" },
  { key: "quantityText", label: "Määrä", kind: "decimal", numeric: true },
  { key: "amountEur", label: "Summa", kind: "decimal", numeric: true },
  { key: "feeEur", label: "Kulut", kind: "decimal", numeric: true },
  { key: "currency", label: "Valuutta", kind: "text" },
  { key: "note", label: "Selite", kind: "text" },
];
```

in place of the read-only table. Problem rows are appended to `rows` as `{ line: p.line, tradeDate: "", type: "BUY", isin: "", quantityText: "", amountEur: "", feeEur: "0", currency: "EUR", note: p.rawLine ?? p.message }` so the owner fills them in or removes them; the separate problems section goes.

`commit` sends, per entry:

```ts
commitImport({
  data: {
    accountId: accountId ?? 0,
    filename: entry.draft.filename,
    sha256: entry.draft.sha256,
    kind:
      entry.file === null
        ? "csv_op"
        : entry.draft.broker === "pdf"
          ? "pdf"
          : entry.draft.broker === "nordnet"
            ? "csv_nordnet"
            : "csv_op",
    draft: {
      txns: entry.rows.map((row, index) =>
        fromEditable(row, entry.draft.txns[index], accountId ?? 0),
      ),
      problems: [],
      unknownIsins: entry.draft.unknownIsins,
    },
  },
});
```

The OP paste commits through the same function now; `commitOpPaste` no longer exists. The file input's `accept` becomes `".csv,.pdf,text/csv,application/pdf"` and its label "CSV- tai PDF-tiedostot (Nordnet, OP, muut välittäjät)".

`summariseAll`/`canCommit` read the edited rows: `good` is `rows.length`; keep `unknown` from the draft. An edited row that names an ISIN the server does not know is refused by the commit's own unknown-instrument check, whose message the screen shows.

- [ ] **Step 3: Typecheck, lint, build, run web tests**

Run: `pnpm typecheck && pnpm lint && pnpm build && pnpm vitest run src/web`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/web/routes/imports.tsx src/web/routes/imports-draft.ts src/web/routes/imports.test.ts
git commit -m "feat(web): edit transaction drafts in the preview, PDFs included"
```

---

### Task 12: Holdings edits, and PDF on the reconcile screen

**Files:**

- Modify: `src/web/routes/SnapshotPaste.tsx`

**Interfaces:**

- Consumes: Task 8 `proposeSnapshotFromPdf`, `saveSnapshot` with `statedTotalEur`; Task 9 `holdingsTotalCheck`; Task 10 `DraftTable`.

- [ ] **Step 1: Route PDFs to the reader and make rows editable**

In `SnapshotPaste.tsx`:

- `accept` becomes `".csv,.pdf,text/csv,text/plain,application/pdf"`; the label "Välittäjän tiedosto (CSV) tai omistusote (PDF)".
- In `preview.mutationFn`, when `file !== null && file.name.toLowerCase().endsWith(".pdf")` (or `file.type === "application/pdf"`), call `proposeSnapshotFromPdf({ data: form })` with only `file` set; the date comes from the statement. `onSuccess` sets `asOf` from `result.asOf` when the PDF path was used.
- Replace `mapping` and the read-only table with `rows` state: `{ line: number; name: string; quantity: string; marketValueEur: string; instrumentId: number | null }[]`, seeded from `result.rows.map((row, i) => ({ line: i + 1, ...row }))`. The instrument select stays as its own column: `DraftTable` columns are `name` (text), `quantity` (decimal), `marketValueEur` (decimal); render the select in a column of kind `{ options: instruments }` whose values are instrument ids as strings, and map back with `Number` in `fromRows`.
- `statedTotalEur` state from `result.statedTotalEur ?? null`; show `holdingsTotalCheck(rows, statedTotalEur)` like the cash screen shows the balance check, and disable save while it is `{ ok: false }`.
- `save` sends `source: file is a PDF ? "pdf" : "manual"`, `statedTotalEur`, and `rows.map((row) => ({ instrumentId: row.instrumentId ?? 0, quantity: row.quantity, marketValue: row.marketValueEur }))`.

- [ ] **Step 2: Typecheck, lint, build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/web/routes/SnapshotPaste.tsx
git commit -m "feat(web): edit a holdings statement, from a PDF too, before reconciling"
```

---

### Task 13: Remove the OP PDF parsers, update the README

**Files:**

- Delete: `src/server/import/bank-pdf.ts`, `src/server/import/bank-pdf-sweep.ts`, `src/server/import/bank-pdf.test.ts`, `src/server/import/bank-pdf-sweep.test.ts`, `src/server/import/fixtures/op-statement-sample.txt`, `src/server/import/fixtures/op-fixed-term-sample.txt`, `src/server/import/fixtures/sweep-statement-sample.txt`
- Modify: `README.md`

- [ ] **Step 1: Delete, then find what still imports them**

```bash
git rm src/server/import/bank-pdf.ts src/server/import/bank-pdf-sweep.ts src/server/import/bank-pdf.test.ts src/server/import/bank-pdf-sweep.test.ts src/server/import/fixtures/op-statement-sample.txt src/server/import/fixtures/op-fixed-term-sample.txt src/server/import/fixtures/sweep-statement-sample.txt
grep -rn "bank-pdf" src
```

Expected: no matches. If `bank-credit.test.ts` or `bank-statement.test.ts` read one of the deleted `.txt` fixtures, keep that fixture and drop it from the `git rm`.

- [ ] **Step 2: README**

In the "Getting data in" section, replace the sentences that describe OP PDF statements being parsed with:

> Any downloaded PDF — a bank statement, a broker's transaction list, a holdings statement — is read by a Workers AI model into a preview you can correct row by row before it is imported. A bank statement is checked against its own opening and closing balances, a holdings statement against its printed total; a file whose rows do not add up is refused until you fix them. Scanned PDFs without a text layer are not supported.

Add to the Configuration table nothing; the reading model is a constant. Add a line under "Both run on Workers AI" naming the PDF reader as a third use.

- [ ] **Step 3: Full verification**

Run: `pnpm fmt && pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: all clean, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add -A src/server/import README.md
git commit -m "refactor(import): the model reads every PDF; the OP statement parsers go"
```

---

## Self-review

- **Spec coverage.** Reading a PDF: Tasks 2–3. Bank flow: 4–5, 10. Broker transactions: 6–7, 11. Holdings: 8, 12. Editing table and live checks: 9–12. Validation on commit: 5, 7, 8. Removals: 13. Testing section: each task's tests plus the real fixture in Task 2.
- **Placeholders.** None; every step carries its code. Task 5 leaves the exact fixture figures to the executor, with the rule that the balance check must hold.
- **Type consistency.** `ChatClient.run` returns `{ text, toolCalls }` everywhere the tests script it. `BankDraft` fields (`amountEur`, `counterparty`, `message`, `externalId`) match between Task 4, Task 5 and Task 10. `CommitDraftBody.kind` matches `ImportKind`. `holdingsTotalCheck` has the same signature in Task 8 (server) and Task 9 (browser), by design.
