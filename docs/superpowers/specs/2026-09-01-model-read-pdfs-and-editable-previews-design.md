# Model-read PDFs and editable previews

Date: 2026-09-01. Status: draft for review.

## Goal

Any downloaded PDF — a bank statement, a broker's transaction list, a holdings
statement — can be imported, and every import preview can be corrected by hand
before it is committed, whatever the file format.

## Decisions already made

- A Workers AI model reads every PDF. The hand-written OP statement parsers
  (`bank-pdf.ts`, `bank-pdf-sweep.ts`) are deleted. CSV and pasted-text
  parsers stay: they are deterministic and free.
- The preview is the source of truth for a commit. The server no longer
  re-parses the file on commit; it commits the rows the client sends back,
  validated with the same schemas.
- Text PDFs only. A PDF with no text layer is refused with the message it gets
  today.

## Reading a PDF

One module, `src/server/import/pdf-read.ts`:

- `extractPages(bytes)` — the existing `unpdf` call, per page, so a long
  statement is sent in batches that fit the model's context. Pages are
  batched to roughly 6 000 words; header facts (period, balances, "as of"
  date) are asked for on the first batch, rows on every batch.
- `readPdf(kind, pages, client)` — one prompt per kind, one JSON schema per
  kind, sent with Workers AI's `response_format: { type: "json_schema" }`.
  The reply is parsed with zod; a reply that fails to parse is one error for
  the whole file. Model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, the
  JSON-mode model already on the chat list, as a constant separate from the
  chat picker. The client is injected the same way the chat's is, so tests
  script it.
- The prompt tells the model to copy figures exactly as printed, to leave a
  row out and list it under `problems` with the printed line rather than
  guess, and to never invent an ISIN.

Three kinds, three schemas, in the wire form the app already uses (money as
decimal strings, never numbers):

| kind           | header                                                            | row                                                                                           |
| -------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `bank`         | `from`, `to`, `openingBalance`, `closingBalance`, `maturityDate?` | `date`, `amount` (signed), `counterparty`, `message`, `reference?`                            |
| `holdings`     | `asOf`, `totalValue?`                                             | `name`, `isin?`, `quantity`, `marketValue`, `currency`                                        |
| `transactions` | —                                                                 | `date`, `type`, `name`, `isin?`, `quantity`, `unitPrice?`, `amount`, `fee`, `tax`, `currency` |

Each reply also carries `problems: [{ line, text }]`.

## The three flows

Every flow has the same three steps. **Preview** turns a file, paste or PDF
into a draft. **Edit** happens in the browser. **Commit** sends the draft back
and the server validates it, checks it, and writes it.

### Bank statement (cash screen)

- Preview: CSV through the existing bank configs; PDF through
  `readPdf("bank")`. Both produce the draft: header (present for PDF, absent
  for CSV) plus rows.
- Check: the balance check runs on the draft's rows against its stated
  balances, and is shown live in the preview as the rows are edited. Commit
  refuses a draft whose rows do not sum to its closing balance.
- Commit: `commitBankDraft(accountId, draft)` — the current commit path with
  the parsed statement replaced by the draft. Opening balance and maturity
  handling are unchanged.

### Broker transactions (Tuonnit)

- Preview: CSV and OP paste as today; PDF through `readPdf("transactions")`.
  Instruments are resolved by ISIN, then by name, as the OP paste already does;
  unresolved ones are the existing unknown-instrument forms.
- Commit: `commitDraft` already takes a draft; the server function now accepts
  the draft as JSON instead of the file. The import record keeps the filename
  and hash from the preview.

### Holdings statement (reconcile screen)

- Preview: CSV and paste as today; PDF through `readPdf("holdings")`.
- Check: when the statement printed a total, the rows' values must sum to it,
  shown live and enforced on commit.
- Commit: `createSnapshot` unchanged; source `pdf` for a model-read file.

## Editing in the preview

One editable table component, `src/web/routes/DraftTable.tsx`, used by all
three screens:

- Every cell of every row is an input. Dates as `YYYY-MM-DD`, money and
  quantities as decimal strings, enums as selects.
- A row can be deleted, and a blank row added at the end.
- Problem rows appear in the same table with their printed text beside them
  and empty fields: fixing one is filling it in. Leaving it empty leaves it out.
- Field errors from the server's validation are shown on the cell they name.
- Nothing is saved until commit. Leaving the screen discards the draft.

## Validation and safety

- Drafts are validated with zod on commit, at the server function, the same
  schemas the preview produced them from. A row the client made up is caught
  there.
- Money never travels as a JSON number.
- The model is never given the ledger, only the PDF's text. Its reading is
  checked (balances, totals) where a check exists, and reviewed where not.
- Duplicate detection on commit is unchanged: by the bank's reference where
  the PDF printed one, by content hash otherwise. A hand-edited row that
  matches a stored one is skipped, as any duplicate is.

## Out of scope

Scanned PDFs, model-read CSVs, storing drafts server-side, learning from
corrections.

## Removals

`bank-pdf.ts`, `bank-pdf-sweep.ts`, their tests and text fixtures, and the
statement-detection code in `bank-service.ts`. The PDF fixtures stay for the
extractor's tests.

## Testing

- `pdf-read.ts`: page batching; prompt and schema per kind; a scripted model
  returning each shape; a malformed reply is one error; a scanned PDF is
  refused.
- Each flow: preview from a scripted model produces the draft; an edited draft
  commits; a draft failing its check is refused with the difference; a draft
  with an invented field is refused by validation.
- `DraftTable`: pure helpers for row editing and the live checks, tested
  without a DOM as the other view modules are.
