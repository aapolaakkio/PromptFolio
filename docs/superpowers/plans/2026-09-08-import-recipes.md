# Import Recipes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A model describes a bank statement PDF's layout once as a small JSON recipe; the backend compiles and runs that recipe over the whole document, verifies it against the statement's own printed balances, and caches it so the same format never costs a model call again.

**Architecture:** A `BankRecipe` is declarative JSON — skip patterns, a record-start regex with named capture groups, continuation patterns, header-fact patterns, a date format and a money format. `recipe/run.ts` interprets it into the existing `PdfStatement` shape from `bank-pdf.ts`, so the already-tested `verifyStatement` arithmetic check and the whole draft/preview/commit path downstream are reused unchanged. Nothing model-authored is ever executed as code — Cloudflare Workers block `eval` and `new Function`, and a recipe only locates text.

**Tech Stack:** TypeScript, Zod v4, Drizzle ORM on Cloudflare D1, Vitest, Workers AI via the existing `ChatClient`.

**Spec:** `docs/superpowers/specs/2026-09-08-import-recipes-design.md`

## Global Constraints

- Branch is `cloudflare-workers`, already reset to `8541961`. `bank-pdf.ts`, `bank-pdf-sweep.ts` and the `.txt` fixtures are present again.
- Immutability: never mutate an input. Build new objects and arrays.
- Files stay focused: 200–400 lines typical, 800 max. Functions under 50 lines.
- All user-facing error strings are in Finnish, matching the existing files.
- Money is `bigint` minor units via `src/core/money.ts`. Never `number`, never floating point.
- Validate at the boundary with Zod. A model reply is untrusted input.
- No test may call a real model. `_setReaderClient` in `bank-service.ts` injects a stub.
- Coverage gate is 80% lines across the project (`pnpm test:cov`).
- Comments are rare and short — match the density of the file you are editing.
- Commit format: `<type>: <description>`, types `feat|fix|refactor|docs|test|chore|perf|ci`. No attribution trailer.
- Run `pnpm check` (lint + format + typecheck + coverage) before the final commit of each task where code changed.

---

### Task 1: Recipe types and their Zod schema

**Files:**

- Create: `src/server/import/recipe/types.ts`
- Test: `src/server/import/recipe/types.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `type MoneyFormat`, `type BankRecipe`, `const BankRecipeSchema: z.ZodType<BankRecipe>`, `const MAX_PATTERN_LENGTH: number`, `const parseRecipe: (raw: unknown) => BankRecipe` (throws `Error` with a Finnish message on invalid input).

- [ ] **Step 1: Write the failing test**

Create `src/server/import/recipe/types.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { MAX_PATTERN_LENGTH, parseRecipe } from "./types.ts";

const valid = {
  kind: "bank",
  skip: ["^Tilinumero"],
  recordStart: String.raw`^(?<date>\d{1,2}\.\d{1,2}\.\d{4})\s+(?<amount>[+\-−\d  ,]+)\s+(?<tail>.*)$`,
  continuation: [String.raw`^(?<externalId>[0-9A-Z]{16,})$`],
  restField: "counterparty",
  header: { openingBalance: String.raw`^(?<value>[\d ,]+)\s+Saldo` },
  dateFormat: "d.m.yyyy",
  money: { decimal: ",", thousands: " ", negative: "leading", twoColumn: false },
};

describe("parseRecipe", () => {
  test("accepts a well-formed recipe", () => {
    expect(parseRecipe(valid).kind).toBe("bank");
  });

  test("refuses a recordStart with no date group", () => {
    const noDate = { ...valid, recordStart: String.raw`^(?<amount>\d+)$` };
    expect(() => parseRecipe(noDate)).toThrow(/date/);
  });

  test("refuses a recordStart with neither amount nor a debit/credit pair", () => {
    const noAmount = { ...valid, recordStart: String.raw`^(?<date>\d+)$` };
    expect(() => parseRecipe(noAmount)).toThrow(/amount/);
  });

  test("accepts a debit/credit pair instead of amount", () => {
    const twoColumn = {
      ...valid,
      recordStart: String.raw`^(?<date>\d+)\s+(?<debit>[\d,]*)\s+(?<credit>[\d,]*)$`,
      money: { ...valid.money, twoColumn: true },
    };
    expect(parseRecipe(twoColumn).money.twoColumn).toBe(true);
  });

  test("refuses a pattern longer than the cap", () => {
    const huge = { ...valid, skip: ["x".repeat(MAX_PATTERN_LENGTH + 1)] };
    expect(() => parseRecipe(huge)).toThrow();
  });

  test("refuses a pattern that is not a valid regex", () => {
    expect(() => parseRecipe({ ...valid, skip: ["("] })).toThrow();
  });

  test("refuses an unknown field", () => {
    expect(() => parseRecipe({ ...valid, extra: 1 })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/import/recipe/types.test.ts`
Expected: FAIL — cannot resolve `./types.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/server/import/recipe/types.ts`:

```ts
import { z } from "zod";

/**
 * A model writes these patterns, so they are capped and compiled before use.
 * Long enough for a real record-start line, short enough that no single pattern
 * can be a denial of service on its own.
 */
export const MAX_PATTERN_LENGTH = 400;

/** A pattern the model wrote: length-capped and known to compile. */
const Pattern = z
  .string()
  .min(1)
  .max(MAX_PATTERN_LENGTH)
  .refine(
    (source) => {
      try {
        new RegExp(source, "u");
        return true;
      } catch {
        return false;
      }
    },
    { message: "Säännöllistä lauseketta ei voitu kääntää" },
  );

const MoneyFormatSchema = z
  .object({
    decimal: z.enum([",", "."]),
    thousands: z.enum([" ", " ", ".", ",", "'", ""]),
    negative: z.enum(["leading", "trailing", "parentheses", "suffix"]),
    debitWords: z.array(z.string().min(1)).max(10).optional(),
    strip: z.array(z.string().min(1)).max(10).optional(),
    twoColumn: z.boolean(),
  })
  .strict();
export type MoneyFormat = z.infer<typeof MoneyFormatSchema>;

const HeaderSchema = z
  .object({
    from: Pattern.optional(),
    to: Pattern.optional(),
    openingBalance: Pattern.optional(),
    closingBalance: Pattern.optional(),
    maturityDate: Pattern.optional(),
  })
  .strict();

const BaseRecipe = z
  .object({
    kind: z.literal("bank"),
    skip: z.array(Pattern).max(40),
    recordStart: Pattern,
    continuation: z.array(Pattern).max(20),
    restField: z.enum(["counterparty", "message"]).nullable(),
    header: HeaderSchema,
    dateFormat: z.enum(["d.m.yyyy", "dd.mm.yyyy", "yyyy-mm-dd", "d.m."]),
    money: MoneyFormatSchema,
  })
  .strict();

const groupNames = (source: string): ReadonlySet<string> =>
  new Set([...source.matchAll(/\(\?<([A-Za-z][A-Za-z0-9]*)>/g)].map((m) => m[1] ?? ""));

/**
 * A record is only a transaction if it says when and how much. Checked here
 * rather than at run time so a recipe that could never produce a row is refused
 * before it is stored, not after it has silently read a statement as empty.
 */
export const BankRecipeSchema = BaseRecipe.superRefine((recipe, ctx) => {
  const groups = groupNames(recipe.recordStart);
  if (!groups.has("date")) {
    ctx.addIssue({ code: "custom", message: "recordStart ei nimeä ryhmää date" });
  }
  const hasPair = groups.has("debit") && groups.has("credit");
  if (!groups.has("amount") && !hasPair) {
    ctx.addIssue({
      code: "custom",
      message: "recordStart ei nimeä ryhmää amount eikä debit/credit",
    });
  }
});

export type BankRecipe = z.infer<typeof BaseRecipe>;

const INVALID = "Mallin kuvaus tiedostomuodosta ei kelpaa";

export const parseRecipe = (raw: unknown): BankRecipe => {
  const parsed = BankRecipeSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${INVALID}: ${parsed.error.message}`);
  return parsed.data;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/import/recipe/types.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/import/recipe/types.ts src/server/import/recipe/types.test.ts
git commit -m "feat(import): a recipe type for a statement's layout, validated at the boundary"
```

---

### Task 2: Reading money the way a recipe describes it

**Files:**

- Create: `src/server/import/recipe/money-format.ts`
- Test: `src/server/import/recipe/money-format.test.ts`

**Interfaces:**

- Consumes: `MoneyFormat` from Task 1; `parseMoney`, `EUR` from `src/core/money.ts`.
- Produces: `const readAmount: (text: string, format: MoneyFormat) => bigint` — signed minor units, throws on unreadable text; `const readTwoColumn: (debit: string, credit: string, format: MoneyFormat) => bigint`.

- [ ] **Step 1: Write the failing test**

Create `src/server/import/recipe/money-format.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import type { MoneyFormat } from "./types.ts";
import { readAmount, readTwoColumn } from "./money-format.ts";

const base: MoneyFormat = {
  decimal: ",",
  thousands: " ",
  negative: "leading",
  twoColumn: false,
};

describe("readAmount", () => {
  test("reads a Finnish amount with a non-breaking thousands separator", () => {
    expect(readAmount("2 750,00", base)).toBe(275_000n);
  });

  test("reads a unicode minus as negative", () => {
    expect(readAmount("−25,90", base)).toBe(-2590n);
  });

  test("drops a leading plus", () => {
    expect(readAmount("+1 574,10", base)).toBe(157_410n);
  });

  test("reads a dot decimal with a comma thousands separator", () => {
    expect(readAmount("1,234.56", { ...base, decimal: ".", thousands: "," })).toBe(123_456n);
  });

  test("reads a dot thousands separator without mistaking it for a decimal", () => {
    expect(readAmount("1.234", { ...base, thousands: "." })).toBe(123_400n);
  });

  test("reads a trailing minus", () => {
    expect(readAmount("1 234,56-", { ...base, negative: "trailing" })).toBe(-123_456n);
  });

  test("reads parentheses as negative", () => {
    expect(readAmount("(1 234,56)", { ...base, negative: "parentheses" })).toBe(-123_456n);
  });

  test("reads a debit word as negative", () => {
    const format: MoneyFormat = { ...base, negative: "suffix", debitWords: ["DR", "VELOITUS"] };
    expect(readAmount("1 234,56 DR", format)).toBe(-123_456n);
    expect(readAmount("1 234,56 CR", format)).toBe(123_456n);
  });

  test("strips a currency code named by the format", () => {
    expect(readAmount("1 234,56 EUR", { ...base, strip: ["EUR"] })).toBe(123_456n);
  });

  test("refuses text that holds no figure", () => {
    expect(() => readAmount("K-MARKET", base)).toThrow();
  });
});

describe("readTwoColumn", () => {
  const format: MoneyFormat = { ...base, twoColumn: true };

  test("a filled debit column is money leaving", () => {
    expect(readTwoColumn("25,90", "", format)).toBe(-2590n);
  });

  test("a filled credit column is money arriving", () => {
    expect(readTwoColumn("", "25,90", format)).toBe(2590n);
  });

  test("refuses a row where both columns are empty", () => {
    expect(() => readTwoColumn("", "", format)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/import/recipe/money-format.test.ts`
Expected: FAIL — cannot resolve `./money-format.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/server/import/recipe/money-format.ts`:

```ts
import { EUR, parseMoney } from "../../../core/money.ts";
import type { MoneyFormat } from "./types.ts";

const UNREADABLE = (text: string): Error =>
  new Error(`Summaa ei voitu lukea: ${JSON.stringify(text)}`);

/**
 * U+2212 is a minus sign that is not the hyphen any parser expects. Normalised
 * for every format: this is a character-identity fix, not a formatting choice
 * the model gets to describe.
 */
const MINUS = /−/g;

const escapeForClass = (text: string): string => text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

/** Sign and bare digits, with the format's own decorations taken off. */
const strip = (text: string, format: MoneyFormat): { body: string; negative: boolean } => {
  let body = text.replace(MINUS, "-").trim();
  for (const word of format.strip ?? []) body = body.split(word).join("");
  body = body.trim();

  let negative = false;
  if (format.negative === "parentheses" && /^\(.*\)$/.test(body)) {
    negative = true;
    body = body.slice(1, -1);
  } else if (format.negative === "trailing" && body.endsWith("-")) {
    negative = true;
    body = body.slice(0, -1);
  } else if (format.negative === "suffix") {
    const upper = body.toUpperCase();
    negative = (format.debitWords ?? []).some((word) => upper.endsWith(word.toUpperCase()));
    body = body.replace(/[A-Za-zÄÖÅäöå]+$/u, "");
  } else if (body.startsWith("-")) {
    negative = true;
    body = body.slice(1);
  }
  return { body: body.replace(/^\+/, "").trim(), negative };
};

/** Signed minor units, read exactly as the format describes. */
export const readAmount = (text: string, format: MoneyFormat): bigint => {
  const { body, negative } = strip(text, format);
  const withoutThousands =
    format.thousands === ""
      ? body
      : body.replace(new RegExp(escapeForClass(format.thousands), "g"), "");
  const plain = withoutThousands.replace(format.decimal, ".").replace(/\s/g, "");
  if (!/^\d+(\.\d+)?$/.test(plain)) throw UNREADABLE(text);
  const { minor } = parseMoney(plain, EUR);
  return negative ? -minor : minor;
};

/**
 * A statement that prints unsigned figures in two columns: which column the
 * figure sat in is the sign, and a row filling neither is not a transaction.
 */
export const readTwoColumn = (debit: string, credit: string, format: MoneyFormat): bigint => {
  const hasDebit = debit.trim() !== "";
  const hasCredit = credit.trim() !== "";
  if (hasDebit === hasCredit) throw UNREADABLE(`${debit} | ${credit}`);
  return hasDebit ? -readAmount(debit, format) : readAmount(credit, format);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/import/recipe/money-format.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/import/recipe/money-format.ts src/server/import/recipe/money-format.test.ts
git commit -m "feat(import): read a statement's figures the way its recipe describes them"
```

---

### Task 3: Dates, as a recipe describes them

**Files:**

- Create: `src/server/import/recipe/date-format.ts`
- Test: `src/server/import/recipe/date-format.test.ts`

**Interfaces:**

- Consumes: `BankRecipe["dateFormat"]` from Task 1.
- Produces: `const readDate: (text: string, format: BankRecipe["dateFormat"], yearHint?: string) => string` — an ISO `YYYY-MM-DD`, throwing on a date the calendar does not have. `yearHint` is a four-digit year used only by the `"d.m."` format.

- [ ] **Step 1: Write the failing test**

Create `src/server/import/recipe/date-format.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { readDate } from "./date-format.ts";

describe("readDate", () => {
  test("reads a Finnish date with single-digit parts", () => {
    expect(readDate("1.8.2026", "d.m.yyyy")).toBe("2026-08-01");
  });

  test("reads a zero-padded Finnish date", () => {
    expect(readDate("01.08.2026", "dd.mm.yyyy")).toBe("2026-08-01");
  });

  test("reads an ISO date unchanged", () => {
    expect(readDate("2026-08-01", "yyyy-mm-dd")).toBe("2026-08-01");
  });

  test("takes the year from the hint when the statement prints none", () => {
    expect(readDate("1.8.", "d.m.", "2026")).toBe("2026-08-01");
  });

  test("refuses a day the calendar does not have", () => {
    expect(() => readDate("32.1.2026", "d.m.yyyy")).toThrow(/ei ole olemassa/);
  });

  test("refuses text that is not a date at all", () => {
    expect(() => readDate("K-MARKET", "d.m.yyyy")).toThrow();
  });

  test("refuses a yearless date with no hint", () => {
    expect(() => readDate("1.8.", "d.m.")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/import/recipe/date-format.test.ts`
Expected: FAIL — cannot resolve `./date-format.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/server/import/recipe/date-format.ts`:

```ts
import type { BankRecipe } from "./types.ts";

/**
 * Round-tripped through `Date` rather than merely reformatted: extraction can
 * join fragments into something that still matches the pattern, and a stored
 * 2026-13-32 sorts wrongly everywhere.
 */
const assertReal = (iso: string, text: string): string => {
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    throw new Error(`Päivämäärää ei ole olemassa: ${JSON.stringify(text)}`);
  }
  return iso;
};

const pad = (part: string): string => part.padStart(2, "0");

export const readDate = (
  text: string,
  format: BankRecipe["dateFormat"],
  yearHint?: string,
): string => {
  const trimmed = text.trim();
  if (format === "yyyy-mm-dd") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (!match) throw new Error(`Päivämäärä ei kelpaa: ${JSON.stringify(text)}`);
    return assertReal(trimmed, text);
  }
  if (format === "d.m.") {
    const match = /^(\d{1,2})\.(\d{1,2})\.$/.exec(trimmed);
    if (!match || yearHint === undefined || !/^\d{4}$/.test(yearHint)) {
      throw new Error(`Päivämäärä ei kelpaa: ${JSON.stringify(text)}`);
    }
    return assertReal(`${yearHint}-${pad(match[2]!)}-${pad(match[1]!)}`, text);
  }
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(trimmed);
  if (!match) throw new Error(`Päivämäärä ei kelpaa: ${JSON.stringify(text)}`);
  return assertReal(`${match[3]!}-${pad(match[2]!)}-${pad(match[1]!)}`, text);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/import/recipe/date-format.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/import/recipe/date-format.ts src/server/import/recipe/date-format.test.ts
git commit -m "feat(import): read a statement's dates the way its recipe describes them"
```

---

### Task 4: The interpreter

**Files:**

- Create: `src/server/import/recipe/run.ts`
- Test: `src/server/import/recipe/run.test.ts`

**Interfaces:**

- Consumes: `BankRecipe` (Task 1), `readAmount`/`readTwoColumn` (Task 2), `readDate` (Task 3), `PdfStatement` and `BankRow` types from `./bank-pdf.ts` and `./bank-statement.ts`.
- Produces:
  - `type RecipeRun = { statement: PdfStatement; unclaimed: readonly { line: number; text: string }[] }`
  - `const runRecipe: (text: string, recipe: BankRecipe) => RecipeRun` — throws only when the header facts a statement must have (`from`, `to`, both balances) cannot be read; a bad row becomes a `problem`, never an exception.

**How a document is read.** Lines are trimmed. A line matching any `skip` pattern is claimed and dropped. A line matching `recordStart` opens a record; the lines after it, up to the next `recordStart`, are that record's block. Each `continuation` pattern is executed against the block joined with `\n`, so a pattern may span lines (`Viesti:\n(?<message>.+)`); the lines its match covers are claimed. `restField` takes the first block line still unclaimed. Any block line still unclaimed after that is reported as unclaimed — that is what makes the model state its `skip` list rather than letting furniture vanish silently.

**Header facts** run against the whole document. `from` and `openingBalance` take the _first_ match, `to` and `closingBalance` the _last_, `maturityDate` the first. A header pattern's value is its named group `value` when it has one, otherwise its first capture group.

- [ ] **Step 1: Write the failing test**

Create `src/server/import/recipe/run.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { runRecipe } from "./run.ts";
import type { BankRecipe } from "./types.ts";

const recipe: BankRecipe = {
  kind: "bank",
  skip: ["^Tiliote$", String.raw`^\d+ \(\d+\)$`],
  recordStart: String.raw`^(?<date>\d{1,2}\.\d{1,2}\.\d{4})\s+(?<amount>[+−\-][\d  ]*,\d{2})\s+(?<label>[A-ZÄÖÅ][A-ZÄÖÅ.\- ]*?)(?:\s+(?<externalId>[0-9A-Z]{16,}))?\s*$`,
  continuation: [String.raw`^Viesti:\n(?<message>.+)$`],
  restField: "counterparty",
  header: {
    from: String.raw`^(?:[+−\-][\d  ]*,\d{2})\s+Saldo\s+(?<value>\d{1,2}\.\d{1,2}\.\d{4})$`,
    to: String.raw`^(?:[+−\-][\d  ]*,\d{2})\s+Saldo\s+(?<value>\d{1,2}\.\d{1,2}\.\d{4})$`,
    openingBalance: String.raw`^(?<value>[+−\-][\d  ]*,\d{2})\s+Saldo\s+\d`,
    closingBalance: String.raw`^(?<value>[+−\-][\d  ]*,\d{2})\s+Saldo\s+\d`,
  },
  dateFormat: "d.m.yyyy",
  money: { decimal: ",", thousands: " ", negative: "leading", twoColumn: false },
};

const doc = [
  "Tiliote",
  "+1 500,00 Saldo 28.8.2025",
  "28.8.2025 −25,90 PKORTTIMAKSU 20250828A1B2C3D4E5F6",
  "K-MARKET ESIMERKKI",
  "Viesti:",
  "Kahvia",
  "1 (2)",
  "29.8.2025 +2 750,00 TILISIIRTO",
  "TYONANTAJA OY",
  "+3 236,44 Saldo 28.8.2026",
].join("\n");

describe("runRecipe", () => {
  test("reads the period and both balances from the header patterns", () => {
    const { statement } = runRecipe(doc, recipe);

    expect(statement.from).toBe("2025-08-28");
    expect(statement.to).toBe("2026-08-28");
    expect(statement.openingBalance.minor).toBe(150_000n);
    expect(statement.closingBalance.minor).toBe(323_644n);
  });

  test("reads every record, with its sign", () => {
    const { statement } = runRecipe(doc, recipe);

    expect(statement.rows.map((row) => row.amount)).toEqual([-2590n, 275_000n]);
  });

  test("takes the counterparty from the first unclaimed block line", () => {
    const { statement } = runRecipe(doc, recipe);

    expect(statement.rows[0]?.counterparty).toBe("K-MARKET ESIMERKKI");
    expect(statement.rows[1]?.counterparty).toBe("TYONANTAJA OY");
  });

  test("a continuation pattern may span two lines", () => {
    const { statement } = runRecipe(doc, recipe);

    expect(statement.rows[0]?.note).toContain("Kahvia");
  });

  test("reads the archive id named on the record-start line", () => {
    const { statement } = runRecipe(doc, recipe);

    expect(statement.rows[0]?.externalId).toBe("20250828A1B2C3D4E5F6");
    expect(statement.rows[1]?.externalId).toBeNull();
  });

  test("types a row by its sign", () => {
    const { statement } = runRecipe(doc, recipe);

    expect(statement.rows.map((row) => row.type)).toEqual(["WITHDRAWAL", "DEPOSIT"]);
  });

  test("types money arriving as interest when the record says korko", () => {
    const withInterest = doc.replace("TILISIIRTO", "TALLETUSKORKO");
    const { statement } = runRecipe(withInterest, recipe);

    expect(statement.rows[1]?.type).toBe("INTEREST");
  });

  test("claims every line of a document the recipe fully describes", () => {
    expect(runRecipe(doc, recipe).unclaimed).toEqual([]);
  });

  test("reports a block line no pattern claimed", () => {
    const withNoise = doc.replace("K-MARKET ESIMERKKI", "K-MARKET ESIMERKKI\nOSTOPVM 28.08.2025");
    const { unclaimed } = runRecipe(withNoise, recipe);

    expect(unclaimed.map((entry) => entry.text)).toEqual(["OSTOPVM 28.08.2025"]);
  });

  test("a record whose amount cannot be read becomes a problem, not an exception", () => {
    const broken = doc.replace("−25,90", "−KAKSI,90");
    const { statement } = runRecipe(broken, recipe);

    expect(statement.rows).toHaveLength(1);
    expect(statement.problems).toHaveLength(1);
  });

  test("refuses a document whose balances the recipe cannot find", () => {
    const noBalances = doc.replace(/.*Saldo.*\n?/g, "");
    expect(() => runRecipe(noBalances, recipe)).toThrow(/saldo/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/import/recipe/run.test.ts`
Expected: FAIL — cannot resolve `./run.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/server/import/recipe/run.ts`:

```ts
import { EUR, money } from "../../../core/money.ts";
import type { PdfStatement } from "../bank-pdf.ts";
import type { BankRow } from "../bank-statement.ts";
import { readDate } from "./date-format.ts";
import { readAmount, readTwoColumn } from "./money-format.ts";
import type { BankRecipe } from "./types.ts";

export type Unclaimed = { readonly line: number; readonly text: string };
export type RecipeRun = {
  readonly statement: PdfStatement;
  readonly unclaimed: readonly Unclaimed[];
};

/** A model wrote these patterns, so the loop that runs them is watched. */
const TIME_BUDGET_MS = 5_000;
const CHECK_EVERY = 200;

const compile = (source: string): RegExp => new RegExp(source, "u");
const compileAll = (sources: readonly string[]): RegExp[] => sources.map(compile);

const groupValue = (match: RegExpExecArray): string | null =>
  match.groups?.value ?? match[1] ?? null;

/** First match for an opening fact, last for a closing one. */
const headerFact = (lines: readonly string[], source: string | undefined, last: boolean) => {
  if (source === undefined) return null;
  const pattern = compile(source);
  const found = lines.flatMap((line) => {
    const match = pattern.exec(line);
    return match ? [groupValue(match)] : [];
  });
  return (last ? found.at(-1) : found[0]) ?? null;
};

const rowType = (note: string, amount: bigint): BankRow["type"] => {
  if (amount > 0n && /korko/i.test(note)) return "INTEREST";
  return amount < 0n ? "WITHDRAWAL" : "DEPOSIT";
};

/** Which of a block's lines a match covers, given the block joined with newlines. */
const linesCovered = (block: readonly string[], start: number, end: number): Set<number> => {
  const covered = new Set<number>();
  let at = 0;
  for (const [index, line] of block.entries()) {
    const lineEnd = at + line.length;
    if (start < lineEnd && end > at) covered.add(index);
    at = lineEnd + 1;
  }
  return covered;
};

export const runRecipe = (text: string, recipe: BankRecipe): RecipeRun => {
  const started = Date.now();
  const lines = text.split("\n").map((line) => line.trim());
  const skip = compileAll(recipe.skip);
  const recordStart = compile(recipe.recordStart);
  const continuation = compileAll(recipe.continuation);

  const fromText = headerFact(lines, recipe.header.from, false);
  const toText = headerFact(lines, recipe.header.to, true);
  const openingText = headerFact(lines, recipe.header.openingBalance, false);
  const closingText = headerFact(lines, recipe.header.closingBalance, true);
  if (fromText === null || toText === null || openingText === null || closingText === null) {
    throw new Error("Tiliotteesta ei löytynyt alku- ja loppusaldoa");
  }
  const from = readDate(fromText, recipe.dateFormat);
  const to = readDate(toText, recipe.dateFormat);
  const yearHint = to.slice(0, 4);

  const maturityText = headerFact(lines, recipe.header.maturityDate, false);
  const maturityDate =
    maturityText === null ? null : readDate(maturityText, recipe.dateFormat, yearHint);

  const rows: BankRow[] = [];
  const problems: Array<{ line: number; message: string }> = [];
  const unclaimed: Unclaimed[] = [];

  const starts = lines.flatMap((line, index) => (recordStart.test(line) ? [index] : []));

  for (const [index, line] of lines.entries()) {
    if (index % CHECK_EVERY === 0 && Date.now() - started > TIME_BUDGET_MS) {
      throw new Error("Tiliotteen lukeminen kesti liian kauan");
    }
    if (line === "" || skip.some((pattern) => pattern.test(line))) continue;
    if (starts.includes(index)) continue;
    // Claimed lines are removed inside the record loop below; anything left
    // over is collected there, so nothing extra happens here.
  }

  const claimed = new Set<number>(starts);
  for (const [index, line] of lines.entries()) {
    if (line === "" || skip.some((pattern) => pattern.test(line))) claimed.add(index);
  }

  for (const [order, start] of starts.entries()) {
    const end = starts[order + 1] ?? lines.length;
    const blockIndexes = Array.from(
      { length: end - start - 1 },
      (_, offset) => start + 1 + offset,
    ).filter((index) => !claimed.has(index));
    const block = blockIndexes.map((index) => lines[index] ?? "");
    const joined = block.join("\n");

    const fields: Record<string, string> = {};
    const consumed = new Set<number>();
    for (const pattern of continuation) {
      const match = pattern.exec(joined);
      if (!match) continue;
      for (const [name, value] of Object.entries(match.groups ?? {})) {
        if (value !== undefined && fields[name] === undefined) fields[name] = value;
      }
      for (const covered of linesCovered(block, match.index, match.index + match[0].length)) {
        consumed.add(covered);
      }
    }

    const remaining = block.flatMap((value, at) => (consumed.has(at) ? [] : [{ value, at }]));
    const rest = remaining[0];
    if (recipe.restField !== null && rest !== undefined) {
      fields[recipe.restField] ??= rest.value;
      consumed.add(rest.at);
    }
    for (const { value, at } of remaining) {
      if (!consumed.has(at)) unclaimed.push({ line: (blockIndexes[at] ?? 0) + 1, text: value });
    }

    const head = recordStart.exec(lines[start] ?? "");
    const groups = { ...(head?.groups ?? {}) };
    try {
      const amount = recipe.money.twoColumn
        ? readTwoColumn(groups.debit ?? "", groups.credit ?? "", recipe.money)
        : readAmount(groups.amount ?? "", recipe.money);
      const counterparty = fields.counterparty ?? groups.counterparty ?? "";
      const note = [groups.label ?? "", counterparty, fields.message ?? ""]
        .map((part) => part.trim())
        .filter((part) => part !== "")
        .join(" — ");
      rows.push({
        line: start + 1,
        date: readDate(groups.date ?? "", recipe.dateFormat, yearHint),
        type: rowType(note, amount),
        amount,
        counterparty,
        note,
        externalId: groups.externalId ?? fields.externalId ?? null,
      });
    } catch (cause) {
      problems.push({
        line: start + 1,
        message: cause instanceof Error ? cause.message : "Rivin käsittely epäonnistui",
      });
    }
  }

  return {
    statement: {
      from,
      to,
      openingBalance: money(readAmount(openingText, recipe.money), EUR),
      closingBalance: money(readAmount(closingText, recipe.money), EUR),
      rows,
      problems,
      maturityDate,
    },
    unclaimed,
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/import/recipe/run.test.ts`
Expected: PASS, 11 tests.

If the first loop over `lines` (the one with only the time-budget check and `continue`s) is flagged by the linter as having an empty body, move the time-budget check into the record loop and delete that loop. It exists only to bound the run; keep whichever placement lints clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/import/recipe/run.ts src/server/import/recipe/run.test.ts
git commit -m "feat(import): run a recipe over a statement's text into the existing draft shape"
```

---

### Task 5: The golden test — a hand-written OP recipe matches the old parser

**Files:**

- Create: `src/server/import/recipe/op-reference.ts`
- Test: `src/server/import/recipe/op-reference.test.ts`

**Interfaces:**

- Consumes: `runRecipe` (Task 4), `parseOpStatementText` from `../bank-pdf.ts`, the fixtures `../fixtures/op-statement-sample.txt` and `../fixtures/op-fixed-term-sample.txt`, `readText` from `../../files.ts`.
- Produces: `const OP_STATEMENT_RECIPE: BankRecipe` — a hand-written recipe, used by tests and as the worked example in the generation prompt (Task 8).

This is the task that proves the recipe format is expressive enough to describe a real statement. If a field cannot be expressed, the format is wrong and the fix belongs here — not in a special case downstream.

- [ ] **Step 1: Write the failing test**

Create `src/server/import/recipe/op-reference.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { readText } from "../../files.ts";
import { parseOpStatementText, verifyStatement } from "../bank-pdf.ts";
import { OP_STATEMENT_RECIPE } from "./op-reference.ts";
import { runRecipe } from "./run.ts";

const fixture = (name: string): Promise<string> =>
  readText(`${import.meta.dirname}/../fixtures/${name}`);

describe("OP_STATEMENT_RECIPE", () => {
  test("reads the same balances the hand-written parser reads", async () => {
    const text = await fixture("op-statement-sample.txt");
    const { statement } = runRecipe(text, OP_STATEMENT_RECIPE);
    const reference = parseOpStatementText(text);

    expect(statement.from).toBe(reference.from);
    expect(statement.to).toBe(reference.to);
    expect(statement.openingBalance.minor).toBe(reference.openingBalance.minor);
    expect(statement.closingBalance.minor).toBe(reference.closingBalance.minor);
  });

  test("reads the same rows the hand-written parser reads", async () => {
    const text = await fixture("op-statement-sample.txt");
    const { statement } = runRecipe(text, OP_STATEMENT_RECIPE);
    const reference = parseOpStatementText(text);

    expect(statement.rows.map((row) => row.amount)).toEqual(
      reference.rows.map((row) => row.amount),
    );
    expect(statement.rows.map((row) => row.date)).toEqual(reference.rows.map((row) => row.date));
    expect(statement.rows.map((row) => row.counterparty)).toEqual(
      reference.rows.map((row) => row.counterparty),
    );
    expect(statement.rows.map((row) => row.externalId)).toEqual(
      reference.rows.map((row) => row.externalId),
    );
    expect(statement.rows.map((row) => row.type)).toEqual(reference.rows.map((row) => row.type));
  });

  test("its rows add up to the balance the statement prints", async () => {
    const { statement } = runRecipe(await fixture("op-statement-sample.txt"), OP_STATEMENT_RECIPE);
    expect(verifyStatement(statement).ok).toBe(true);
  });

  test("claims every line of the statement", async () => {
    const { unclaimed } = runRecipe(await fixture("op-statement-sample.txt"), OP_STATEMENT_RECIPE);
    expect(unclaimed).toEqual([]);
  });

  test("reads the fixed-term statement and its maturity date", async () => {
    const text = await fixture("op-fixed-term-sample.txt");
    const { statement } = runRecipe(text, OP_STATEMENT_RECIPE);
    const reference = parseOpStatementText(text);

    expect(statement.maturityDate).toBe(reference.maturityDate);
    expect(verifyStatement(statement).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/import/recipe/op-reference.test.ts`
Expected: FAIL — cannot resolve `./op-reference.ts`.

- [ ] **Step 3: Write the recipe**

Create `src/server/import/recipe/op-reference.ts`. Start from the patterns already in `bank-pdf.ts` (`DATE`, `AMOUNT`, `HEADER`, `BALANCE`, `FURNITURE`, `BIC_LINE`, `IBAN_LINE`, `PERIOD_LINE`, `TERMINAL_NOISE`, `ARCHIVE_ID`, `MATURITY`) — this recipe is those rules restated declaratively:

```ts
import type { BankRecipe } from "./types.ts";

const DATE = String.raw`\d{1,2}\.\d{1,2}\.\d{4}`;
const AMOUNT = String.raw`[+−-]?\d{1,3}(?:[  ]\d{3})*,\d{2}`;

/**
 * OP's PDF statement, written as a recipe rather than as code. The patterns are
 * `bank-pdf.ts`'s own, restated: this is the reference the interpreter is held
 * to, and the worked example the generation prompt shows the model.
 */
export const OP_STATEMENT_RECIPE: BankRecipe = {
  kind: "bank",
  skip: [
    String.raw`^(Tilinumero|BIC|Kirjaus-|päivä|Arvopäivä|Määrä,|euroa|Selitys|Maksunsaaja/maksaja|Viesti$|Viite|Saajan|Tiliote|Käyttötili|Määräaikainen|Eräpäivä|Ajalta|Asiakkaan tulostama|Jatkuu)`,
    String.raw`^\d+ \(\d+\)$`,
    String.raw`^[A-Z]{6}[A-Z0-9]{2,5}$`,
    String.raw`^[A-Z]{2}\d{2}(\s\d{4})+(\s\d{1,4})?$`,
    `^${DATE}\\s*-\\s*${DATE}$`,
    String.raw`^(\d{6}\*+\d{4}|MF NRO|VARMENTAJA|OSTOPVM)`,
    `^${AMOUNT}\\s+Saldo\\s+${DATE}$`,
    `^${DATE}$`,
  ],
  recordStart:
    `^(?<date>${DATE})\\s+(?<amount>${AMOUNT})\\s+` +
    String.raw`(?<label>[A-ZÄÖÅ][A-ZÄÖÅ.-]*(?:\s+[A-ZÄÖÅ][A-ZÄÖÅ.-]*)*)?` +
    String.raw`(?:\s+(?<externalId>[0-9A-Z]{16,}))?.*$`,
  continuation: [String.raw`^Viesti:\n(?<message>.+)$`, String.raw`^(?<externalId>[0-9A-Z]{16,})$`],
  restField: "counterparty",
  header: {
    from: `^${AMOUNT}\\s+Saldo\\s+(?<value>${DATE})$`,
    to: `^${AMOUNT}\\s+Saldo\\s+(?<value>${DATE})$`,
    openingBalance: `^(?<value>${AMOUNT})\\s+Saldo\\s+${DATE}$`,
    closingBalance: `^(?<value>${AMOUNT})\\s+Saldo\\s+${DATE}$`,
    maturityDate: `^Eräpäivä\\s+(?<value>${DATE})$`,
  },
  dateFormat: "d.m.yyyy",
  money: { decimal: ",", thousands: " ", negative: "leading", twoColumn: false },
};
```

- [ ] **Step 4: Run the test and close the gaps**

Run: `pnpm vitest run src/server/import/recipe/op-reference.test.ts`

Expect this to fail at first and to need two or three rounds. Read each failure and fix it in the _recipe_, not in the interpreter — unless the failure shows something the recipe format genuinely cannot express, in which case extend `types.ts` and `run.ts` and say so in the commit message.

Two failures to expect specifically:

- The fixed-term fixture prints `Eräpäivä` and its date on separate lines. If `maturityDate` finds nothing, the header pattern needs to span lines the way a continuation does; make `headerFact` in `run.ts` run each header pattern against the whole joined text as well as line by line, preferring a line match.
- The statement's own account number appears mid-block after a page break and would be taken as a counterparty. The IBAN entry in `skip` covers it; if the fixture prints it in another shape, widen that entry.

Expected once green: PASS, 5 tests.

- [ ] **Step 5: Run the whole suite**

Run: `pnpm vitest run src/server/import`
Expected: PASS. `bank-pdf.test.ts` must still pass untouched — the reference has not moved.

- [ ] **Step 6: Commit**

```bash
git add src/server/import/recipe/op-reference.ts src/server/import/recipe/op-reference.test.ts src/server/import/recipe/run.ts
git commit -m "test(import): a hand-written OP recipe reproduces the parser's rows exactly"
```

---

### Task 6: Verification

**Files:**

- Create: `src/server/import/recipe/verify.ts`
- Test: `src/server/import/recipe/verify.test.ts`

**Interfaces:**

- Consumes: `RecipeRun` (Task 4), `verifyStatement` from `../bank-pdf.ts`, `formatMoney`/`money`/`EUR` from `src/core/money.ts`.
- Produces:
  - `type Verdict = { ok: true } | { ok: false; report: string }`
  - `const verifyRun: (run: RecipeRun) => Verdict` — `report` is the text sent back to the model on the retry, listing unclaimed lines and the balance delta.

- [ ] **Step 1: Write the failing test**

Create `src/server/import/recipe/verify.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { EUR, money } from "../../../core/money.ts";
import type { RecipeRun } from "./run.ts";
import { verifyRun } from "./verify.ts";

const run = (
  over: Partial<RecipeRun["statement"]> = {},
  unclaimed: RecipeRun["unclaimed"] = [],
): RecipeRun => ({
  statement: {
    from: "2025-08-28",
    to: "2026-08-28",
    openingBalance: money(150_000n, EUR),
    closingBalance: money(323_644n, EUR),
    rows: [
      {
        line: 3,
        date: "2025-08-28",
        type: "WITHDRAWAL",
        amount: -2590n,
        counterparty: "K-MARKET",
        note: "K-MARKET",
        externalId: null,
      },
      {
        line: 8,
        date: "2025-08-29",
        type: "DEPOSIT",
        amount: 176_234n,
        counterparty: "TYONANTAJA",
        note: "TYONANTAJA",
        externalId: null,
      },
    ],
    problems: [],
    maturityDate: null,
    ...over,
  },
  unclaimed,
});

describe("verifyRun", () => {
  test("passes when the rows add up and every line was claimed", () => {
    expect(verifyRun(run())).toEqual({ ok: true });
  });

  test("fails when the rows do not reach the printed closing balance", () => {
    const verdict = verifyRun(run({ closingBalance: money(999_999n, EUR) }));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.report).toMatch(/Saldotarkistus/);
  });

  test("names the difference so the model can see a sign error", () => {
    const verdict = verifyRun(run({ closingBalance: money(328_824n, EUR) }));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.report).toContain("51.80");
  });

  test("fails when a line was left unclaimed, and quotes it", () => {
    const verdict = verifyRun(run({}, [{ line: 7, text: "OSTOPVM 28.08.2025" }]));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.report).toContain("OSTOPVM 28.08.2025");
  });

  test("fails when a row's date falls outside the statement's period", () => {
    const outside = run();
    const verdict = verifyRun({
      ...outside,
      statement: {
        ...outside.statement,
        rows: [{ ...outside.statement.rows[0]!, date: "2030-01-01" }, outside.statement.rows[1]!],
      },
    });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.report).toMatch(/2030-01-01/);
  });

  test("lists at most ten unclaimed lines", () => {
    const many = Array.from({ length: 25 }, (_, at) => ({ line: at, text: `rivi ${at}` }));
    const verdict = verifyRun(run({}, many));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.report.match(/rivi \d+/g)).toHaveLength(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/import/recipe/verify.test.ts`
Expected: FAIL — cannot resolve `./verify.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/server/import/recipe/verify.ts`:

```ts
import { EUR, formatMoney, money } from "../../../core/money.ts";
import { verifyStatement } from "../bank-pdf.ts";
import type { RecipeRun } from "./run.ts";

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly report: string };

/** Enough for the model to see the pattern, short enough to stay a prompt. */
const MAX_LISTED = 10;

const eur = (minor: bigint): string => formatMoney(money(minor, EUR));

export const verifyRun = ({ statement, unclaimed }: RecipeRun): Verdict => {
  const complaints: string[] = [];

  if (unclaimed.length > 0) {
    const listed = unclaimed
      .slice(0, MAX_LISTED)
      .map((entry) => `  rivi ${entry.line}: ${JSON.stringify(entry.text)}`)
      .join("\n");
    complaints.push(`Kuvaus jätti ${unclaimed.length} riviä tunnistamatta:\n${listed}`);
  }

  const check = verifyStatement(statement);
  if (!check.ok) {
    complaints.push(
      `Saldotarkistus: alkusaldo ${eur(statement.openingBalance.minor)} + rivit = ` +
        `${eur(check.actualEur)}, ote tulostaa ${eur(check.expectedEur)} ` +
        `(ero ${eur(check.differenceEur)}).`,
    );
  }

  const outside = statement.rows.filter(
    (row) => row.date < statement.from || row.date > statement.to,
  );
  if (outside.length > 0) {
    complaints.push(
      `Jakson ${statement.from}…${statement.to} ulkopuolisia päiviä: ` +
        outside
          .slice(0, MAX_LISTED)
          .map((row) => row.date)
          .join(", "),
    );
  }

  return complaints.length === 0 ? { ok: true } : { ok: false, report: complaints.join("\n\n") };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/import/recipe/verify.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/import/recipe/verify.ts src/server/import/recipe/verify.test.ts
git commit -m "feat(import): verify a recipe against the statement's own printed balance"
```

---

### Task 7: Fingerprint and storage

**Files:**

- Create: `src/server/import/recipe/fingerprint.ts`, `src/server/import/recipe/store.ts`
- Create: `src/server/import/recipe/fingerprint.test.ts`, `src/server/import/recipe/store.test.ts`
- Modify: `src/server/db/schema.ts` (append the `importRecipes` table)
- Create: a Drizzle migration under `drizzle/` (generated, not hand-written)

**Interfaces:**

- Consumes: `BankRecipe`/`parseRecipe` (Task 1), `db` from `../../db/index.ts`, `createHash` from `node:crypto`.
- Produces:
  - `const shape: (line: string) => string`
  - `const fingerprint: (producer: string, lines: readonly string[]) => string`
  - `const loadRecipe: (userId: string, fingerprint: string) => Promise<BankRecipe | null>`
  - `const saveRecipe: (userId: string, fingerprint: string, recipe: BankRecipe) => Promise<void>`
  - `const forgetRecipe: (userId: string, fingerprint: string) => Promise<void>`

- [ ] **Step 1: Write the failing fingerprint test**

Create `src/server/import/recipe/fingerprint.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { fingerprint, shape } from "./fingerprint.ts";

describe("shape", () => {
  test("blanks digits so a value cannot change the layout", () => {
    expect(shape("Tiliote 1.8.2026 - 31.8.2026")).toBe("Tiliote #.#.# - #.#.#");
  });

  test("blanks an account number", () => {
    expect(shape("FI12 3456 7890 1234 56")).toBe("FI## #### #### #### ##");
  });
});

describe("fingerprint", () => {
  test("two statements of different months share a fingerprint", () => {
    const august = ["Tiliote", "1.8.2026 - 31.8.2026", "FI12 3456 7890 1234 56"];
    const september = ["Tiliote", "1.9.2026 - 30.9.2026", "FI12 3456 7890 1234 56"];

    expect(fingerprint("pdfTeX", august)).toBe(fingerprint("pdfTeX", september));
  });

  test("a different layout gets a different fingerprint", () => {
    const op = ["Tiliote", "1.8.2026 - 31.8.2026"];
    const other = ["Kontoutdrag", "2026-08-01 - 2026-08-31"];

    expect(fingerprint("pdfTeX", op)).not.toBe(fingerprint("pdfTeX", other));
  });

  test("a different producer gets a different fingerprint", () => {
    const lines = ["Tiliote", "1.8.2026 - 31.8.2026"];
    expect(fingerprint("pdfTeX", lines)).not.toBe(fingerprint("Word", lines));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/server/import/recipe/fingerprint.test.ts`
Expected: FAIL — cannot resolve `./fingerprint.ts`.

- [ ] **Step 3: Write the fingerprint**

Create `src/server/import/recipe/fingerprint.ts`:

```ts
import { createHash } from "node:crypto";

/** How many of the document's opening lines identify its layout. */
const SAMPLE_LINES = 5;

/**
 * A line with its figures blanked. Next month's statement prints a different
 * period and different balances in the same places, so hashing the raw lines
 * would make every statement a new format and the cache would never hit.
 */
export const shape = (line: string): string => line.replace(/\d/g, "#").trim();

export const fingerprint = (producer: string, lines: readonly string[]): string => {
  const sample = lines
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, SAMPLE_LINES)
    .map(shape);
  return createHash("sha256")
    .update([producer, ...sample].join("\n"))
    .digest("hex");
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run src/server/import/recipe/fingerprint.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add the table to the schema**

Append to `src/server/db/schema.ts` (the file already imports `integer`, `sqliteTable`, `text`, `unique` and `sql`; add nothing to the import list that is already there):

```ts
/**
 * A layout the model has already described, keyed by the shape of a document's
 * opening lines. Per user and never shared: a recipe may legitimately quote a
 * literal from the owner's own statement.
 */
export const importRecipes = sqliteTable(
  "import_recipes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    kind: text("kind", { enum: ["bank"] }).notNull(),
    /** The validated BankRecipe as JSON. Re-validated on read. */
    recipe: text("recipe").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [unique().on(t.userId, t.fingerprint)],
);
```

- [ ] **Step 6: Generate and apply the migration**

```bash
pnpm db:generate
pnpm db:migrate:local
```

Expected: a new directory under `drizzle/` containing a `CREATE TABLE import_recipes`. Read the generated SQL and confirm it creates the table and the unique index, and drops nothing.

- [ ] **Step 7: Write the failing store test**

Create `src/server/import/recipe/store.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "vitest";

import { db } from "../../db/index.ts";
import { importRecipes, user } from "../../db/schema.ts";
import { OP_STATEMENT_RECIPE } from "./op-reference.ts";
import { forgetRecipe, loadRecipe, saveRecipe } from "./store.ts";

const USER = "recipe-store-user";

beforeEach(async () => {
  await db.delete(importRecipes);
  await db
    .insert(user)
    .values({
      id: USER,
      name: "Testi",
      email: `${USER}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
});

describe("recipe store", () => {
  test("a saved recipe comes back", async () => {
    await saveRecipe(USER, "fp-1", OP_STATEMENT_RECIPE);
    expect(await loadRecipe(USER, "fp-1")).toEqual(OP_STATEMENT_RECIPE);
  });

  test("an unknown fingerprint reads as null", async () => {
    expect(await loadRecipe(USER, "never-seen")).toBeNull();
  });

  test("saving the same fingerprint twice replaces it", async () => {
    await saveRecipe(USER, "fp-1", OP_STATEMENT_RECIPE);
    const changed = { ...OP_STATEMENT_RECIPE, restField: "message" as const };
    await saveRecipe(USER, "fp-1", changed);

    expect((await loadRecipe(USER, "fp-1"))?.restField).toBe("message");
  });

  test("a forgotten recipe is gone", async () => {
    await saveRecipe(USER, "fp-1", OP_STATEMENT_RECIPE);
    await forgetRecipe(USER, "fp-1");

    expect(await loadRecipe(USER, "fp-1")).toBeNull();
  });

  test("another user's fingerprint is not visible", async () => {
    await saveRecipe(USER, "fp-1", OP_STATEMENT_RECIPE);
    expect(await loadRecipe("someone-else", "fp-1")).toBeNull();
  });

  test("a stored row that no longer validates reads as null rather than throwing", async () => {
    await db.insert(importRecipes).values({
      userId: USER,
      fingerprint: "fp-bad",
      kind: "bank",
      recipe: JSON.stringify({ kind: "bank" }),
    });

    expect(await loadRecipe(USER, "fp-bad")).toBeNull();
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `pnpm vitest run src/server/import/recipe/store.test.ts`
Expected: FAIL — cannot resolve `./store.ts`.

- [ ] **Step 9: Write the store**

Create `src/server/import/recipe/store.ts`:

```ts
import { and, eq } from "drizzle-orm";

import { db } from "../../db/index.ts";
import { importRecipes } from "../../db/schema.ts";
import { parseRecipe, type BankRecipe } from "./types.ts";

/**
 * A stored recipe is re-validated on the way out. A row written by an older
 * shape of the schema is treated as a miss, so the model describes the layout
 * again -- one extra call, never a wrong import.
 */
export const loadRecipe = async (
  userId: string,
  fingerprint: string,
): Promise<BankRecipe | null> => {
  const row = await db
    .select({ recipe: importRecipes.recipe })
    .from(importRecipes)
    .where(and(eq(importRecipes.userId, userId), eq(importRecipes.fingerprint, fingerprint)))
    .get();
  if (!row) return null;
  try {
    return parseRecipe(JSON.parse(row.recipe));
  } catch {
    return null;
  }
};

export const saveRecipe = async (
  userId: string,
  fingerprint: string,
  recipe: BankRecipe,
): Promise<void> => {
  await db
    .insert(importRecipes)
    .values({ userId, fingerprint, kind: "bank", recipe: JSON.stringify(recipe) })
    .onConflictDoUpdate({
      target: [importRecipes.userId, importRecipes.fingerprint],
      set: { recipe: JSON.stringify(recipe) },
    });
};

export const forgetRecipe = async (userId: string, fingerprint: string): Promise<void> => {
  await db
    .delete(importRecipes)
    .where(and(eq(importRecipes.userId, userId), eq(importRecipes.fingerprint, fingerprint)));
};
```

- [ ] **Step 10: Run it to verify it passes**

Run: `pnpm vitest run src/server/import/recipe/store.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 11: Commit**

```bash
git add src/server/import/recipe/fingerprint.ts src/server/import/recipe/fingerprint.test.ts \
        src/server/import/recipe/store.ts src/server/import/recipe/store.test.ts \
        src/server/db/schema.ts drizzle
git commit -m "feat(import): remember a described layout under a digit-blanked fingerprint"
```

---

### Task 8: Asking the model for a recipe

**Files:**

- Create: `src/server/import/recipe/generate.ts`
- Test: `src/server/import/recipe/generate.test.ts`

**Interfaces:**

- Consumes: `ChatClient` from `../../chat/runner.ts`, `jsonObject` and `PDF_READ_MODEL` from `../pdf-read.ts`, `parseRecipe` (Task 1), `runRecipe` (Task 4), `verifyRun` (Task 6), `OP_STATEMENT_RECIPE` (Task 5).
- Produces:
  - `const sampleFor: (pages: readonly PdfPage[]) => string`
  - `const generateRecipe: (text: string, pages: readonly PdfPage[], client: ChatClient) => Promise<{ recipe: BankRecipe; run: RecipeRun; verified: boolean }>` — asks once, verifies, retries once with the report, and returns the better of the two attempts. `verified` says whether the returned run passed; the caller decides whether to store it.

- [ ] **Step 1: Write the failing test**

Create `src/server/import/recipe/generate.test.ts`:

````ts
import { describe, expect, test } from "vitest";

import { readText } from "../../files.ts";
import type { ChatClient } from "../../chat/runner.ts";
import { generateRecipe, sampleFor } from "./generate.ts";
import { OP_STATEMENT_RECIPE } from "./op-reference.ts";

const fixture = (): Promise<string> =>
  readText(`${import.meta.dirname}/../fixtures/op-statement-sample.txt`);

const pagesOf = (text: string) => [{ number: 1, text }];

/** Replies in order; records what it was asked. */
const stub = (...replies: string[]): ChatClient & { asked: string[] } => {
  const asked: string[] = [];
  let at = 0;
  return {
    asked,
    run: async (params) => {
      asked.push(params.messages.map((m) => m.content).join("\n"));
      const reply = replies[at] ?? replies.at(-1) ?? "";
      at += 1;
      return { text: reply, toolCalls: [] };
    },
  } as ChatClient & { asked: string[] };
};

const good = JSON.stringify(OP_STATEMENT_RECIPE);
const wrongSign = JSON.stringify({
  ...OP_STATEMENT_RECIPE,
  money: { ...OP_STATEMENT_RECIPE.money, negative: "trailing" },
});

describe("sampleFor", () => {
  test("sends the first page whole and the tail of the last", () => {
    const sample = sampleFor([
      { number: 1, text: "eka sivu" },
      { number: 2, text: "keski" },
      { number: 3, text: "vika sivu" },
    ]);

    expect(sample).toContain("eka sivu");
    expect(sample).toContain("vika sivu");
    expect(sample).not.toContain("keski");
  });

  test("does not repeat a single page", () => {
    const sample = sampleFor([{ number: 1, text: "ainoa" }]);
    expect(sample.match(/ainoa/g)).toHaveLength(1);
  });
});

describe("generateRecipe", () => {
  test("returns a verified recipe from a good first answer", async () => {
    const text = await fixture();
    const client = stub(good);

    const result = await generateRecipe(text, pagesOf(text), client);

    expect(result.verified).toBe(true);
    expect(client.asked).toHaveLength(1);
  });

  test("retries once with the report when the first answer does not verify", async () => {
    const text = await fixture();
    const client = stub(wrongSign, good);

    const result = await generateRecipe(text, pagesOf(text), client);

    expect(result.verified).toBe(true);
    expect(client.asked).toHaveLength(2);
    expect(client.asked[1]).toMatch(/Saldotarkistus/);
  });

  test("gives back the unverified run when both answers fail", async () => {
    const text = await fixture();
    const client = stub(wrongSign, wrongSign);

    const result = await generateRecipe(text, pagesOf(text), client);

    expect(result.verified).toBe(false);
    expect(result.run.statement.rows.length).toBeGreaterThan(0);
  });

  test("accepts an answer wrapped in a fenced block", async () => {
    const text = await fixture();
    const client = stub("Tässä kuvaus:\n```json\n" + good + "\n```");

    expect((await generateRecipe(text, pagesOf(text), client)).verified).toBe(true);
  });

  test("refuses a reply that holds no JSON at all", async () => {
    const text = await fixture();
    await expect(generateRecipe(text, pagesOf(text), stub("en osaa"))).rejects.toThrow();
  });

  test("refuses a reply whose JSON is not a recipe", async () => {
    const text = await fixture();
    await expect(generateRecipe(text, pagesOf(text), stub('{"kind":"bank"}'))).rejects.toThrow();
  });

  test("shows the model the worked example", async () => {
    const text = await fixture();
    const client = stub(good);
    await generateRecipe(text, pagesOf(text), client);

    expect(client.asked[0]).toContain("recordStart");
  });
});
````

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/import/recipe/generate.test.ts`
Expected: FAIL — cannot resolve `./generate.ts`.

- [ ] **Step 3: Write minimal implementation**

Create `src/server/import/recipe/generate.ts`:

```ts
import type { ChatClient } from "../../chat/runner.ts";
import { jsonObject, PDF_READ_MODEL, type PdfPage } from "../pdf-read.ts";
import { OP_STATEMENT_RECIPE } from "./op-reference.ts";
import { runRecipe, type RecipeRun } from "./run.ts";
import { parseRecipe, type BankRecipe } from "./types.ts";
import { verifyRun } from "./verify.ts";

/** A recipe is about a kilobyte; this is room for one with comments stripped. */
const MAX_TOKENS = 4096;
/** How much of the last page the closing balance could be hiding in. */
const TAIL_LINES = 15;

const NO_ANSWER = "Malli ei kuvannut tiedostomuotoa";

export const sampleFor = (pages: readonly PdfPage[]): string => {
  const first = pages[0];
  const last = pages.length > 1 ? pages.at(-1) : undefined;
  const tail = last?.text.split("\n").slice(0, TAIL_LINES).join("\n");
  return [
    `--- sivu ${first?.number ?? 1} ---\n${first?.text ?? ""}`,
    tail === undefined ? "" : `--- viimeinen sivu (alku) ---\n${tail}`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
};

const INSTRUCTIONS = `Saat otteen pankin tiliotteen tekstisisällöstä. Älä poimi tapahtumia. Kuvaa sen sijaan tiedoston rakenne JSON-oliona, jonka ohjelma ajaa koko tiedostolle.

Kentät:
- skip: säännölliset lausekkeet riveille jotka eivät ole tapahtumia (otsikot, sivunumerot, tilinumerot, saldorivit). Jokaisen rivin on osuttava johonkin: skip, recordStart, continuation tai restField.
- recordStart: tapahtuman aloittava rivi. Nimetyt ryhmät ovat kenttiä: date (pakollinen), amount (tai debit ja credit), label, externalId.
- continuation: lausekkeet tapahtuman seuraaville riveille. Ajetaan riveihin jotka on liitetty rivinvaihdoilla, joten lauseke saa ulottua usealle riville.
- restField: mihin kenttään ensimmäinen muuten tunnistamaton rivi menee.
- header: koko tiedostosta haettavat lausekkeet. Arvo on ryhmä (?<value>...).
- dateFormat: d.m.yyyy, dd.mm.yyyy, yyyy-mm-dd tai d.m.
- money: miten luvut on painettu (desimaalierotin, tuhaterotin, miinuksen paikka).

Säännöt:
- Älä keksi kenttiä joita ei ole listattu.
- Vastaa pelkällä JSON-oliolla, ilman selityksiä.

Esimerkki toisesta pankista:
${JSON.stringify(OP_STATEMENT_RECIPE)}`;

const ask = async (
  client: ChatClient,
  messages: { role: "system" | "user"; content: string }[],
) => {
  const reply = await client.run({
    model: PDF_READ_MODEL,
    max_tokens: MAX_TOKENS,
    messages,
    tools: [],
  });
  const object = jsonObject(reply.text);
  if (object === null) throw new Error(NO_ANSWER);
  let raw: unknown;
  try {
    raw = JSON.parse(object);
  } catch {
    throw new Error(NO_ANSWER);
  }
  return parseRecipe(raw);
};

/**
 * One description, checked; and if it does not hold up, one more with the
 * complaint attached. Never a third: a model that has missed twice is guessing,
 * and the owner's review screen is a better use of the next minute.
 */
export const generateRecipe = async (
  text: string,
  pages: readonly PdfPage[],
  client: ChatClient,
): Promise<{ recipe: BankRecipe; run: RecipeRun; verified: boolean }> => {
  const sample = sampleFor(pages);
  const first = await ask(client, [
    { role: "system", content: INSTRUCTIONS },
    { role: "user", content: sample },
  ]);
  const firstRun = runRecipe(text, first);
  const firstVerdict = verifyRun(firstRun);
  if (firstVerdict.ok) return { recipe: first, run: firstRun, verified: true };

  const second = await ask(client, [
    { role: "system", content: INSTRUCTIONS },
    { role: "user", content: sample },
    {
      role: "user",
      content: `Edellinen kuvauksesi:\n${JSON.stringify(first)}\n\n${firstVerdict.report}\n\nKorjaa kuvaus. Vastaa pelkällä JSON-oliolla.`,
    },
  ]);
  const secondRun = runRecipe(text, second);
  if (verifyRun(secondRun).ok) return { recipe: second, run: secondRun, verified: true };

  return { recipe: first, run: firstRun, verified: false };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/import/recipe/generate.test.ts`
Expected: PASS, 9 tests.

If `ChatClient`'s `run` signature does not accept the `messages` array as typed, read its definition at `src/server/chat/runner.ts` and match it exactly — do not widen the type to `any`.

- [ ] **Step 5: Commit**

```bash
git add src/server/import/recipe/generate.ts src/server/import/recipe/generate.test.ts
git commit -m "feat(import): ask the model to describe a statement's layout, and check its answer"
```

---

### Task 9: Wire the recipe path into the bank import

**Files:**

- Create: `src/server/import/recipe/read.ts`
- Test: `src/server/import/recipe/read.test.ts`
- Modify: `src/server/import/bank-service.ts` (the `readStatement` PDF branch, around lines 44–75)
- Modify: `src/server/import/bank-draft.ts` (add `bankDraftFromStatement`)
- Modify: `src/server/import/pdf-read.ts` (remove `readBankPdf`, `BankBatch`, `BankReading`, `PROMPTS.bank`)
- Modify: `src/server/import/bank-service.test.ts` (the PDF cases now stub a recipe reply)

**Interfaces:**

- Consumes: everything from Tasks 1–8.
- Produces:
  - `const readBankPdfByRecipe: (bytes: ArrayBuffer, userId: string, client: ChatClient) => Promise<RecipeRun>`
  - `const bankDraftFromStatement: (statement: PdfStatement, unclaimed: readonly Unclaimed[]) => BankDraft`

The flow: extract text and pages, fingerprint, load a stored recipe. On a hit, run it and verify; if it fails, forget it and fall through to generation. On generation, store only a verified recipe. Either way, return the run — the draft is built from whatever rows there are, with unclaimed lines as problems.

- [ ] **Step 1: Write the failing test**

Create `src/server/import/recipe/read.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "vitest";

import { db } from "../../db/index.ts";
import { importRecipes, user } from "../../db/schema.ts";
import { readBytes } from "../../files.ts";
import type { ChatClient } from "../../chat/runner.ts";
import { OP_STATEMENT_RECIPE } from "./op-reference.ts";
import { readBankPdfByRecipe } from "./read.ts";

const USER = "recipe-read-user";

const pdf = (): Promise<ArrayBuffer> =>
  readBytes(`${import.meta.dirname}/../fixtures/op-statement-sample.pdf`);

const stub = (...replies: string[]): ChatClient & { calls: number } => {
  let at = 0;
  const client = {
    calls: 0,
    run: async () => {
      client.calls += 1;
      const reply = replies[at] ?? replies.at(-1) ?? "";
      at += 1;
      return { text: reply, toolCalls: [] };
    },
  };
  return client as unknown as ChatClient & { calls: number };
};

beforeEach(async () => {
  await db.delete(importRecipes);
  await db
    .insert(user)
    .values({
      id: USER,
      name: "Testi",
      email: `${USER}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
});

describe("readBankPdfByRecipe", () => {
  test("asks the model once and stores the recipe it verified", async () => {
    const client = stub(JSON.stringify(OP_STATEMENT_RECIPE));

    const run = await readBankPdfByRecipe(await pdf(), USER, client);

    expect(run.statement.rows.length).toBeGreaterThan(0);
    expect(client.calls).toBe(1);
    expect(await db.select().from(importRecipes).all()).toHaveLength(1);
  });

  test("the second import of the same format asks the model nothing", async () => {
    const first = stub(JSON.stringify(OP_STATEMENT_RECIPE));
    await readBankPdfByRecipe(await pdf(), USER, first);

    const second = stub("tätä ei pitäisi kysyä");
    const run = await readBankPdfByRecipe(await pdf(), USER, second);

    expect(second.calls).toBe(0);
    expect(run.statement.rows.length).toBeGreaterThan(0);
  });

  test("a stored recipe that stops working is forgotten and asked again", async () => {
    await db.insert(importRecipes).values({
      userId: USER,
      fingerprint: "wrong-but-present",
      kind: "bank",
      recipe: JSON.stringify({ ...OP_STATEMENT_RECIPE, skip: [] }),
    });
    // The stored row is under a fingerprint this document does not produce, so
    // it is a miss; the self-heal case is the one below.
    const client = stub(JSON.stringify(OP_STATEMENT_RECIPE));
    await readBankPdfByRecipe(await pdf(), USER, client);

    expect(client.calls).toBe(1);
  });

  test("a stored recipe under the right fingerprint that fails is replaced", async () => {
    const client = stub(
      JSON.stringify({ ...OP_STATEMENT_RECIPE, skip: [] }),
      JSON.stringify(OP_STATEMENT_RECIPE),
    );
    // First import: the model's answer does not verify, so nothing is stored.
    await readBankPdfByRecipe(await pdf(), USER, client);
    expect(await db.select().from(importRecipes).all()).toHaveLength(0);

    // Second import: a good answer is stored.
    const better = stub(JSON.stringify(OP_STATEMENT_RECIPE));
    await readBankPdfByRecipe(await pdf(), USER, better);
    expect(await db.select().from(importRecipes).all()).toHaveLength(1);
  });

  test("refuses a PDF with no text layer", async () => {
    const scanned = await readBytes(`${import.meta.dirname}/../fixtures/scanned-no-text.pdf`);
    await expect(
      readBankPdfByRecipe(scanned, USER, stub(JSON.stringify(OP_STATEMENT_RECIPE))),
    ).rejects.toThrow(/tekstiä/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/import/recipe/read.test.ts`
Expected: FAIL — cannot resolve `./read.ts`.

- [ ] **Step 3: Write the reader**

Create `src/server/import/recipe/read.ts`:

```ts
import type { ChatClient } from "../../chat/runner.ts";
import { extractPages } from "../pdf-read.ts";
import { fingerprint } from "./fingerprint.ts";
import { generateRecipe } from "./generate.ts";
import { runRecipe, type RecipeRun } from "./run.ts";
import { forgetRecipe, loadRecipe, saveRecipe } from "./store.ts";
import { verifyRun } from "./verify.ts";

/**
 * The producer a PDF names itself by, when it names one. Part of the
 * fingerprint because two banks can open with the same words and not the same
 * layout, and one bank's own generator rarely changes between statements.
 */
const producerOf = (bytes: ArrayBuffer): string => {
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 4096));
  return /\/Producer\s*\(([^)]{0,80})\)/.exec(head)?.[1] ?? "";
};

/**
 * A statement read by whichever recipe applies: the stored one when its
 * fingerprint matches and it still holds up, a freshly described one
 * otherwise. Only a verified recipe is stored, so a bad description costs one
 * import's review and never the next one's.
 */
export const readBankPdfByRecipe = async (
  bytes: ArrayBuffer,
  userId: string,
  client: ChatClient,
): Promise<RecipeRun> => {
  const pages = await extractPages(bytes);
  const text = pages.map((page) => page.text).join("\n");
  const key = fingerprint(producerOf(bytes), (pages[0]?.text ?? "").split("\n"));

  const stored = await loadRecipe(userId, key);
  if (stored !== null) {
    const run = runRecipe(text, stored);
    if (verifyRun(run).ok) return run;
    await forgetRecipe(userId, key);
  }

  const { recipe, run, verified } = await generateRecipe(text, pages, client);
  if (verified) await saveRecipe(userId, key, recipe);
  return run;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/import/recipe/read.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add `bankDraftFromStatement`**

In `src/server/import/bank-draft.ts`, add beside `bankDraftFromReading`. Read `bankDraftFromReading` (line 67) and `bankDraftFromRows` (line 118) first and match their shape exactly:

```ts
/**
 * A recipe-read statement as the browser edits it. Unclaimed lines ride along
 * as problems: a line nobody could account for is the owner's to look at, and
 * silently dropping it is how a missing transaction stays missing.
 */
export const bankDraftFromStatement = (
  statement: PdfStatement,
  unclaimed: readonly { line: number; text: string }[],
): BankDraft => ({
  statement: {
    from: statement.from,
    to: statement.to,
    openingBalanceEur: formatMoney(statement.openingBalance),
    closingBalanceEur: formatMoney(statement.closingBalance),
    maturityDate: statement.maturityDate,
  },
  rows: statement.rows.map((row) => ({
    line: row.line,
    date: row.date,
    type: row.type,
    amountEur: formatMoney({ minor: row.amount, currency: EUR }),
    counterparty: row.counterparty,
    label: "",
    message: row.note,
    externalId: row.externalId,
  })),
  problems: [
    ...statement.problems.map((problem) => ({ line: problem.line, text: problem.message })),
    ...unclaimed.map((entry) => ({ line: entry.line, text: `Tunnistamaton rivi: ${entry.text}` })),
  ].sort((a, b) => a.line - b.line),
});
```

Add `import type { PdfStatement } from "./bank-pdf.ts";` to the file's imports.

- [ ] **Step 6: Switch the bank service's PDF branch**

In `src/server/import/bank-service.ts`, replace the `try` block inside `readStatement`:

```ts
try {
  const run = await readBankPdfByRecipe(bytes, userId, readerClient ?? createClient());
  return { bank: "pdf", draft: bankDraftFromStatement(run.statement, run.unclaimed) };
} catch (cause) {
  throw asBadRequest(cause);
}
```

`readStatement` now needs the owner: change its signature to `(bytes: ArrayBuffer, userId: string)` and pass `userId` from `previewBankStatement` (line 287) and `commitBankStatementUpload` (line 359), both of which already receive it. Update the imports: drop `extractPages, readBankPdf` from `./pdf-read.ts`, drop `bankDraftFromReading`, add `readBankPdfByRecipe` from `./recipe/read.ts` and `bankDraftFromStatement` from `./bank-draft.ts`.

- [ ] **Step 7: Update the bank service's PDF tests**

In `src/server/import/bank-service.test.ts`, the PDF cases stub a reading. They now stub a recipe. Find each `_setReaderClient` stub whose reply is a `BankReading` JSON and replace the reply with `JSON.stringify(OP_STATEMENT_RECIPE)`, importing it from `./recipe/op-reference.ts`. The assertions on the resulting draft should not need to change — the rows are the same rows.

Run: `pnpm vitest run src/server/import/bank-service.test.ts`
Expected: PASS. Fix the stubs until it does; do not weaken an assertion to make it pass.

- [ ] **Step 8: Remove the bank half of the streaming reader**

From `src/server/import/pdf-read.ts`, delete `BankRow`, `BankRowWire`, `BankBatch`, `BankReading`, `readBankPdf` and `PROMPTS.bank`. Leave the holdings and transactions readers untouched — later specs move them. From `src/server/import/bank-draft.ts`, delete `bankDraftFromReading` and its `BankReading` import once nothing references them.

Run: `pnpm vitest run` and `pnpm typecheck`
Expected: PASS. A remaining reference to a deleted export is a compile error, which is the point of doing this as its own step.

- [ ] **Step 9: Full check**

Run: `pnpm check`
Expected: lint, format, typecheck and coverage all pass, coverage at or above 80% lines.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(import): read a bank PDF through a described recipe, not a streamed reading

A statement's layout is described once by the model and stored under the
shape of its opening lines, so the next statement of the same format is
parsed locally and costs no model call. The description is checked against
the statement's own printed balance before it is trusted or stored."
```

---

## Self-Review

**Spec coverage.** Recipe type and its limits: Task 1. Money formats described rather than guessed: Task 2. Date formats: Task 3. Interpreter, record blocks, coverage tracking, the regex time budget: Task 4. The golden test that proves the format is expressive enough: Task 5. Coverage and arithmetic verification with the retry report: Task 6. Fingerprint stability, the D1 table, user scoping, self-healing: Tasks 7 and 9. Sample selection, prompt, one retry: Task 8. Wiring and the removal of the streamed bank reader: Task 9. The spec's "what follows" section is deliberately not implemented here.

**Placeholders.** None. Every step names its file, its command and its expected result; every code step carries the code.

**Type consistency.** `BankRecipe`/`MoneyFormat`/`parseRecipe` (Task 1) are used under those names throughout. `readAmount`/`readTwoColumn` (Task 2) and `readDate` (Task 3) match their call sites in Task 4. `RecipeRun` with `{ statement, unclaimed }` is produced in Task 4 and consumed under that shape in Tasks 6, 8 and 9. `verifyRun` returns `Verdict` and is called as such in Tasks 8 and 9. `loadRecipe`/`saveRecipe`/`forgetRecipe` (Task 7) match their use in Task 9. `PdfStatement`, `BankRow` and `verifyStatement` are the existing exports of `bank-pdf.ts` and `bank-statement.ts`, reused rather than redefined.

**Known risk to watch in Task 5.** The OP recipe is the plan's least certain code, because it restates by pattern what `bank-pdf.ts` does partly by procedure — the counterparty scan across a page break, and the archive id that sits on the header line in one statement and below the row in another. Task 5 budgets for two or three rounds against the fixtures and says explicitly which file to change when the format falls short. If the recipe cannot be made to match, that is a finding about the format worth reporting before Task 8 builds a prompt around it.
