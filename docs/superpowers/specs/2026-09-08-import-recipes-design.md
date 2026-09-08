# Import recipes: the model writes the parser, the backend runs it

Date: 2026-09-08
Status: approved design, ready for an implementation plan
Scope of this spec: the recipe engine and the bank statement PDF. Holdings PDFs,
broker transaction PDFs and CSV normalisation follow in later specs.

## Why

The branch replaced hand-written PDF parsers with a model that transcribes every
row of a statement into JSON. It works and it is unusably slow: the answer is
longer than the document it came from, so a statement's import waits on tens of
thousands of streamed characters, and a page's worth of figures rides on the
model getting every one of them right.

The model's real advantage is not transcription. It is that it can look at an
unfamiliar layout and describe it. So it describes the layout once, in about a
kilobyte of JSON, and the backend does the reading: fast, deterministic, and
repeatable on next month's statement without asking the model anything at all.

Cloudflare Workers block `eval` and `new Function`, so model-authored JavaScript
is not an option without Dynamic Worker Loaders. It is also not wanted: a
declarative recipe validated at the boundary is the smaller and safer thing.

## The recipe

A bank transaction in a PDF is not one line. It is a header line carrying the
date and the amount, followed by lines holding the payee, the message and the
archive id, with page furniture mixed in. A recipe therefore describes a block,
not a row.

```ts
/** src/server/import/recipe/types.ts */

/** How this bank prints money. Every field is described, never guessed. */
export type MoneyFormat = {
  readonly decimal: "," | ".";
  /** Between thousands. Removed before parsing. "" when the bank uses none. */
  readonly thousands: " " | "\u00a0" | "." | "," | "'" | "";
  /**
   * Where the minus lives. "trailing" is `1 234,56-`; "parentheses" is
   * `(1 234,56)`; "suffix" is a DR/CR-style word named in `debitWords`.
   */
  readonly negative: "leading" | "trailing" | "parentheses" | "suffix";
  /** Words that mark money out when `negative` is "suffix", e.g. ["DR", "VELOITUS"]. */
  readonly debitWords?: readonly string[];
  /** Text stripped before parsing: "EUR", "€", a leading "+". */
  readonly strip?: readonly string[];
  /**
   * True when the amount cell carries no sign and direction comes from which
   * column it sat in. Then `recordStart` captures `debit`/`credit` rather
   * than `amount`.
   */
  readonly twoColumn: boolean;
};

export type BankRecipe = {
  readonly kind: "bank";
  /** Whole-line regexes for page furniture: headings, IBANs, page numbers. Dropped first. */
  readonly skip: readonly string[];
  /**
   * Starts a transaction. Named groups are canonical fields: `date`, `tail`,
   * and either `amount` or the pair `debit`/`credit`.
   */
  readonly recordStart: string;
  /** Pulled out of the record's remaining lines. Named groups again. */
  readonly continuation: readonly string[];
  /** Leftover continuation lines, joined, land here. */
  readonly restField: "counterparty" | "message" | null;
  /** Document-level facts, searched across the whole text. */
  readonly header: {
    readonly from?: string;
    readonly to?: string;
    readonly openingBalance?: string;
    readonly closingBalance?: string;
    readonly maturityDate?: string;
  };
  readonly dateFormat: "d.m.yyyy" | "dd.mm.yyyy" | "yyyy-mm-dd" | "d.m.";
  readonly money: MoneyFormat;
};
```

Three deliberate limits on what a recipe may express:

**Named capture groups are the field map.** The model writes
`(?<date>\d{1,2}\.\d{1,2}\.\d{4})` and that is the wiring. There is no second
index table to keep in sync with the pattern.

**Money formatting is described, not guessed.** Banks differ, and no heuristic
settles `1.234` — thousands separator or two decimal places. A wrong
`MoneyFormat` is caught loudly by the arithmetic check below, which is what
makes handing this to the model acceptable. `−` (U+2212) to `-` remains a fixed
normalisation: that is a character-identity fix, not a format choice.

**A recipe only locates text.** No transforms, no expression language, no
arithmetic. Sign conventions, date validity, and transaction typing stay in
existing typed code, where they are already tested.

Model-authored regexes are length-capped, compiled inside a `try`, and the run
loop checks elapsed time every 200 lines and aborts. A pathological pattern
costs one failed import, never a hung worker.

## How a recipe is made

```
upload (PDF)
 └ extractPages()                       existing code
   └ fingerprint = sha256(pdf producer + shape of first 5 non-empty lines)
     ├ HIT  → load stored recipe
     └ MISS → sample = page 1 in full + first 15 lines of the last page
              model writes BankRecipe JSON
   └ run recipe on ALL pages, locally
     └ verify
        ├ pass → store recipe under fingerprint, build draft
        ├ fail → one retry: model sees its recipe and what went wrong
        └ fail again → draft from what matched, misses as problems, nothing stored
```

The last page joins the sample because the closing balance and any `Eräpäivä`
are printed there, and a row split across a page break is where the
record-cutting rule gets tested.

The recipe JSON is validated against a Zod schema before it is compiled. Bad
JSON or a schema-invalid recipe is a failed generation, not a crash — the same
boundary discipline `pdf-read.ts` applies to readings today.

## Verification

Two checks, both local and cheap.

**Coverage.** Every non-blank line must be claimed: by `skip`, by `recordStart`,
or as a continuation of a record. Zero unclaimed lines are required. A bank that
prints something we ignore has to say so through `skip`, so "ignored" is always
a stated decision rather than an accident.

**Arithmetic.** `openingBalance + Σ amounts === closingBalance`, exact in minor
units as `bigint`. Every row date must parse and fall inside `from…to`.

A failure sends one retry carrying the recipe, the unclaimed lines and the
balance delta:

```
Your recipe left 7 lines unclaimed:
  "  1 234,56 Saldo 31.8.2026"
  ...
Balance check: opening 1240,50 + rows 138,20 = 1378,70,
statement prints 1102,30 (off by 276,40).
Fix the recipe. Answer with JSON only.
```

The delta is a strong hint: being off by exactly twice one row's value says the
sign rule is wrong.

A second failure stores nothing. The draft is built from the rows that did
match, with the misses listed as problems, and the existing editable preview
carries it to the owner.

## Storage

```ts
/** src/server/db/schema.ts */
export const importRecipes = sqliteTable(
  "import_recipes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Layout fingerprint; see `fingerprint()`. Unique per user. */
    fingerprint: text("fingerprint").notNull(),
    kind: text("kind", { enum: ["bank"] }).notNull(),
    /** The validated BankRecipe, as JSON. Re-validated on read. */
    recipe: text("recipe").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [unique().on(t.userId, t.fingerprint)],
);
```

**The fingerprint has to survive next month's statement.** Raw first lines do
not: they carry the period and the balances, so every statement would look like
a new format and the cache would never hit. The sample is digit-blanked first,
so what is hashed is the layout rather than the values.

```
"Tiliote 1.8.2026 - 31.8.2026"  →  "Tiliote #.#.# - #.#.#"
"FI12 3456 7890 1234 56"        →  "FI## #### #### #### ##"
```

```ts
const shape = (line: string): string => line.replace(/\d/g, "#").trim();
```

**User-scoped, never shared.** A recipe can legitimately contain a literal from
the owner's statement — the model may write their IBAN into `skip`. That sits
beside their own imports, which is fine, but it means recipes never cross users
and a recipe is never written to a log or an error message.

**Self-healing.** A stored recipe that hits and then fails verification (the
bank changed its layout) has its row deleted, and generation runs once as though
it were a miss. A stale recipe costs one extra model call, never a wrong import.

## Files

```
src/server/import/recipe/
  types.ts        BankRecipe, MoneyFormat + Zod schemas       ~120 lines
  fingerprint.ts  shape() + fingerprint()                      ~30
  run.ts          interpreter: pages → BankRow[] + coverage    ~180
  verify.ts       coverage + arithmetic checks                  ~90
  generate.ts     sample, prompt, parse, retry                 ~150
  store.ts        load/save/forget by fingerprint               ~60
```

One branch changes in `bank-service.ts`:

```ts
// before
const reading = await readBankPdf(pages, readerClient ?? createClient());
return { bank: "pdf", draft: bankDraftFromReading(reading) };

// after
const statement = await readBankPdfByRecipe(pages, userId, readerClient ?? createClient());
return { bank: "pdf", draft: bankDraftFromStatement(statement) };
```

`readBankPdf` and its `BankBatch` schema leave `pdf-read.ts`. The holdings and
transactions readers stay untouched until the later specs.

`bank-pdf.ts`, restored by the branch reset, stops being the OP parser and
becomes the fixture-backed reference: its real statements are the corpus that
proves the interpreter reproduces its rows exactly.

## Tests

Written first, and no test ever calls a real model — `_setReaderClient` exists
for exactly this.

| What          | How                                                                                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Money formats | Table-driven: every `MoneyFormat` variant × sample strings → expected minor units. Includes `1 234,56-`, `(1 234,56)`, `1.234,56`, `1,234.56`.                                                        |
| Interpreter   | Record cutting on the real `op-statement-sample.pdf` text, including a row split across a page break.                                                                                                 |
| Golden test   | A hand-written OP recipe run through `run.ts` produces exactly the rows the old `bank-pdf.ts` produced from the same fixtures. No model involved. This proves the recipe format is expressive enough. |
| Verify        | Deliberately broken recipes: a wrong sign rule yields a balance delta, a missing `skip` yields unclaimed lines. Both messages asserted.                                                               |
| Generate      | Stubbed `ChatClient`: good recipe, malformed JSON, schema-invalid recipe, fail-then-retry-succeeds, fail-twice.                                                                                       |
| Store         | Fingerprint stability across two statements of different months; self-heal on a failing stored recipe.                                                                                                |
| Integration   | `bank-service` PDF upload end to end with the stub client, asserting the existing draft shape.                                                                                                        |

## Model

Start with `@cf/qwen/qwen3.8-27b`, the model already in use. Writing regexes is
harder than transcribing text, but the output is roughly a kilobyte and a retry
is nearly free, so a bigger model is a change to make when fixtures demand it
rather than in advance. The client stays injectable.

## What follows this spec

**Spec 2 — holdings and transaction PDFs.** The same engine with different field
lists. Holdings keep an arithmetic check (the sum of market values against the
printed total); broker transaction listings generally do not.

**Spec 3 — CSV normalisation.** The same three pieces with a smaller job: one
row is one line, so record cutting collapses into a header-name to
`CanonicalField` map plus a `typeMap` and a `MoneyFormat` — which is the
existing `FieldMapping` type, with the model filling it in instead of
`brokers.ts`.

A CSV has no balance to check against. Verification there is coverage plus
"every type label is mapped", which is weaker than the bank PDF's arithmetic.
That gap is the reason to build the PDF case first: it is where the check is
real, so it is where the idea gets proven before it is trusted anywhere weaker.

## Branch reset

This design starts from `8541961`, dropping only `b57f202` ("the model reads
every PDF; the OP statement parsers go"). The editable-preview commits are kept,
and the hand-written OP PDF parsers come back as the reference corpus above.
