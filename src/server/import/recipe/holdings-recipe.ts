import { z } from "zod";

import { EUR, formatMoney, parseMoney } from "../../../core/money.ts";
import type { ChatClient } from "../../chat/runner.ts";
import { parseCsv } from "../csv.ts";
import { askForRecipe, FINNISH_CONTEXT } from "./ask.ts";
import { readDate } from "./date-format.ts";
import { fingerprint } from "./fingerprint.ts";
import { readDecimal } from "./money-format.ts";
import { forgetRecipe, loadParsed, saveRecipe } from "./store.ts";
import { groupNames, MoneyFormatSchema, Pattern } from "./types.ts";

const SAMPLE_LINES = 120;
const QUOTED_FAILURES = 10;
const NOT_READABLE = "The text was not recognised as a holdings list";

const HOLDING_FIELDS = ["name", "isin", "quantity", "marketValue", "cost", "currency"] as const;
type HoldingField = (typeof HOLDING_FIELDS)[number];
const FIELD_NAMES: ReadonlySet<string> = new Set(HOLDING_FIELDS);
const isField = (name: string): name is HoldingField => FIELD_NAMES.has(name);

const BaseHoldings = z
  .object({
    kind: z.literal("holdings"),
    layout: z.enum(["table", "record"]),
    delimiter: z.enum([";", ",", "\t", "|"]).nullable(),
    columns: z
      .array(z.object({ field: z.enum(HOLDING_FIELDS), header: z.string().min(1) }).strict())
      .max(HOLDING_FIELDS.length),
    skip: z.array(Pattern).max(40),
    recordStart: Pattern.nullable(),
    record: Pattern.nullable(),
    asOf: Pattern.nullable(),
    total: Pattern.nullable(),
    dateFormat: z.enum(["d.m.yyyy", "dd.mm.yyyy", "m.d.yyyy", "yyyy-mm-dd"]),
    money: MoneyFormatSchema,
  })
  .strict();

const fieldsOf = (recipe: HoldingsRecipe): HoldingField[] =>
  recipe.layout === "table"
    ? recipe.columns.map((column) => column.field)
    : groupNames(recipe.record ?? "").filter(isField);

export const HoldingsRecipeSchema = BaseHoldings.superRefine((recipe, ctx) => {
  if (recipe.layout === "table" && recipe.delimiter === null) {
    ctx.addIssue({ code: "custom", message: "A table must have a delimiter" });
  }
  if (recipe.layout === "record" && (recipe.record === null || recipe.recordStart === null)) {
    ctx.addIssue({ code: "custom", message: "A record layout must have recordStart and record" });
  }
  const fields = fieldsOf(recipe);
  for (const required of ["name", "quantity", "marketValue"] as const) {
    if (!fields.includes(required)) {
      ctx.addIssue({ code: "custom", message: `Missing field: ${required}` });
    }
  }
});

export type HoldingsRecipe = z.infer<typeof BaseHoldings>;

// eslint-disable-next-line anti-slop/no-unknown-parameters
const parseHoldingsRecipe = (raw: unknown): HoldingsRecipe => HoldingsRecipeSchema.parse(raw);

export type Holding = {
  readonly name: string;
  readonly isin: string | null;
  readonly quantity: string;
  readonly marketValueEur: string;
  readonly costEur: string;
  readonly currency: string;
};

type HoldingsRun = {
  readonly asOf: string | null;
  readonly statedTotalEur: string | null;
  readonly holdings: readonly Holding[];
  readonly problems: readonly {
    readonly line: number;
    readonly message: string;
    readonly raw: string;
  }[];
};

const toCents = (text: string, recipe: HoldingsRecipe): string =>
  formatMoney(parseMoney(readDecimal(text, recipe.money), EUR));

const holdingOf = (raw: Partial<Record<HoldingField, string>>, recipe: HoldingsRecipe): Holding => {
  const name = (raw.name ?? "").trim();
  if (name === "") throw new Error("Name is missing");
  const cost = (raw.cost ?? "").trim();
  return {
    name,
    isin: (raw.isin ?? "").trim() || null,
    quantity: readDecimal(raw.quantity ?? "", recipe.money),
    marketValueEur: toCents(raw.marketValue ?? "", recipe),
    costEur: cost === "" ? "" : toCents(cost, recipe),
    currency: (raw.currency ?? "").trim().toUpperCase() || EUR,
  };
};

const valueOf = (source: string | null, text: string): string | null => {
  if (source === null) return null;
  const match = new RegExp(source, "um").exec(text);
  return match?.groups?.value?.trim() ?? null;
};

const tableRows = (text: string, recipe: HoldingsRecipe) => {
  const skip = recipe.skip.map((source) => new RegExp(source, "u"));
  const kept = text
    .split(/\r?\n/)
    .filter((line) => !skip.some((pattern) => pattern.test(line.trim())))
    .join("\n");
  const bytes = new TextEncoder().encode(kept).buffer;
  const parsed = parseCsv(bytes, { encoding: "utf-8", delimiter: recipe.delimiter ?? "\t" });
  const missing = recipe.columns.filter((c) => !parsed.headers.includes(c.header));
  if (missing.length > 0) {
    return {
      rows: [],
      problems: [
        {
          line: 1,
          message: `These columns are not in the header row: ${missing.map((c) => c.header).join(", ")}`,
          raw: parsed.headers.join(" | "),
        },
      ],
    };
  }
  return {
    rows: parsed.rows.map((row) => ({
      line: row.line,
      raw: row.cells.join(" | "),
      fields: Object.fromEntries(recipe.columns.map((c) => [c.field, row.values[c.header] ?? ""])),
    })),
    problems: parsed.problems.map(({ line, message, raw }) => ({ line, message, raw })),
  };
};

const recordRows = (text: string, recipe: HoldingsRecipe) => {
  const skip = recipe.skip.map((source) => new RegExp(source, "u"));
  const start = new RegExp(recipe.recordStart ?? "^$", "u");
  const record = new RegExp(`^(?:${recipe.record ?? ""})$`, "u");
  const lines = text
    .split(/\r?\n/)
    .map((value, index) => ({ line: index + 1, text: value.trim() }))
    .filter((entry) => entry.text !== "" && !skip.some((pattern) => pattern.test(entry.text)));

  const blocks: { line: number; lines: string[] }[] = [];
  for (const entry of lines) {
    const current = blocks.at(-1);
    if (current === undefined || start.test(entry.text)) {
      blocks.push({ line: entry.line, lines: [entry.text] });
    } else {
      current.lines.push(entry.text);
    }
  }
  const rows: { line: number; raw: string; fields: Partial<Record<HoldingField, string>> }[] = [];
  const problems: { line: number; message: string; raw: string }[] = [];
  for (const block of blocks) {
    const joined = block.lines.join("\n");
    const match = record.exec(joined);
    if (match === null) {
      problems.push({ line: block.line, message: `Row not read: ${joined}`, raw: joined });
      continue;
    }
    rows.push({ line: block.line, raw: joined, fields: { ...match.groups } });
  }
  return { rows, problems };
};

export const runHoldingsRecipe = (text: string, recipe: HoldingsRecipe): HoldingsRun => {
  const { rows, problems } =
    recipe.layout === "table" ? tableRows(text, recipe) : recordRows(text, recipe);
  const holdings: Holding[] = [];
  const allProblems = [...problems];
  for (const row of rows) {
    try {
      holdings.push(holdingOf(row.fields, recipe));
    } catch (cause) {
      allProblems.push({
        line: row.line,
        message: cause instanceof Error ? cause.message : "Row not read",
        raw: row.raw,
      });
    }
  }
  const asOfText = valueOf(recipe.asOf, text);
  const totalText = valueOf(recipe.total, text);
  return {
    asOf: asOfText === null ? null : readDate(asOfText, recipe.dateFormat),
    statedTotalEur: totalText === null ? null : toCents(totalText, recipe),
    holdings,
    problems: allProblems,
  };
};

const sumOf = (holdings: readonly Holding[]): string =>
  formatMoney({
    minor: holdings.reduce((sum, h) => sum + parseMoney(h.marketValueEur, EUR).minor, 0n),
    currency: EUR,
  });

const judge = (run: HoldingsRun, needsAsOf: boolean) => {
  const reasons: string[] = run.problems
    .slice(0, QUOTED_FAILURES)
    .map((p) => `line ${p.line}: ${p.message}`);
  if (run.holdings.length === 0) reasons.push("No holdings were read.");
  if (needsAsOf && run.asOf === null) reasons.push("asOf did not find the statement date.");
  if (run.statedTotalEur !== null && sumOf(run.holdings) !== run.statedTotalEur) {
    reasons.push(
      `The holdings sum to ${sumOf(run.holdings)}, which does not match the statement total ${run.statedTotalEur}.`,
    );
  }
  return { passed: reasons.length === 0, score: run.holdings.length, feedback: reasons.join("\n") };
};

const INSTRUCTIONS = [
  FINNISH_CONTEXT,
  "You receive a securities holdings statement as text: a table (CSV or copied), a view copied from a web service where every value is on its own line, or text extracted from a PDF. Describe its format as a JSON object that the program uses to read every holding.",
  "layout: table if the text has a header row and columns; then delimiter and columns (headers exactly as written). Otherwise record: skip removes headings and subheadings, recordStart is the line a holding starts at, record is a regular expression matching one whole holding (its lines joined with \\n).",
  "Fields (columns or the record's named groups): name, isin, quantity number of units, marketValue market value, cost cost basis, currency. Required: name, quantity, marketValue.",
  "asOf: a regular expression whose group value is the statement date, or null. total: a pattern whose group value is the total value the statement states, or null if there is none.",
  "money gives the decimal and thousands separators, the negative notation, and in the strip list the units to remove (e.g. kpl, EUR).",
].join("\n");

const holdingsRecipeKey = (text: string): string =>
  fingerprint(
    "holdings",
    text.split(/\r?\n/).filter((line) => line.trim() !== ""),
  );

export const readHoldingsByRecipe = async (
  text: string,
  userId: string,
  client: ChatClient,
  needsAsOf: boolean,
): Promise<HoldingsRun> => {
  const key = holdingsRecipeKey(text);
  const stored = await loadParsed(userId, key, parseHoldingsRecipe);
  if (stored !== null) {
    const run = runHoldingsRecipe(text, stored);
    if (judge(run, needsAsOf).passed) return run;
    await forgetRecipe(userId, key);
  }
  const asked = await askForRecipe({
    client,
    instructions: INSTRUCTIONS,
    sample: text.split(/\r?\n/).slice(0, SAMPLE_LINES).join("\n"),
    schema: HoldingsRecipeSchema,
    run: (recipe: HoldingsRecipe) => runHoldingsRecipe(text, recipe),
    judge: (run) => judge(run, needsAsOf),
  });
  if (asked === null) throw new Error(NOT_READABLE);
  if (asked.verified) await saveRecipe(userId, key, asked.recipe);
  return asked.run;
};

export const decodeHoldingsFile = (bytes: Uint8Array): string => {
  const utf16le = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
  const utf16be = bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff;
  const encoding = utf16le ? "utf-16le" : utf16be ? "utf-16be" : "utf-8";
  return new TextDecoder(encoding).decode(bytes).replace(/^﻿/, "");
};
