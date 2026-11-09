import { z } from "zod";

import type { ChatClient } from "../../chat/runner.ts";
import type { CanonicalField, CsvProblem, RawRow } from "../types.ts";
import { askForRecipe, FINNISH_CONTEXT } from "./ask.ts";
import {
  FIELDS,
  type KnownInstruments,
  MOVES_MONEY,
  mapNormalised,
  mappingOf,
  passes,
  feedbackOf,
  readField,
  type TableRun,
  TYPE_RULES,
  TypeRuleSchema,
} from "./broker-table.ts";
import { fingerprint } from "./fingerprint.ts";
import { forgetRecipe, loadParsed, saveRecipe } from "./store.ts";
import { groupNames, MoneyFormatSchema, Pattern } from "./types.ts";

const LOOKS_LIKE_TRANSACTION = [
  /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/u,
  /\d[.,]\d{2}\b/u,
];

const SAMPLE_LINES = 120;
const NOT_READABLE = "The text was not recognised as a transaction list";

const FIELD_NAMES: ReadonlySet<string> = new Set(FIELDS);
const isField = (name: string): name is CanonicalField => FIELD_NAMES.has(name);

/** Records are cut at a start pattern, or at blank lines when there is none; `record` reads one, its named groups being the fields. */
const BaseBrokerRecord = z
  .object({
    kind: z.literal("broker-record"),
    skip: z.array(Pattern).max(40),
    recordStart: Pattern.nullable(),
    record: Pattern,
    dateFormat: z.enum(["d.m.yyyy", "dd.mm.yyyy", "m.d.yyyy", "yyyy-mm-dd"]),
    money: MoneyFormatSchema,
    unsignedAmount: z.boolean(),
    types: z.array(TypeRuleSchema).max(80),
  })
  .strict();

export const BrokerRecordSchema = BaseBrokerRecord.superRefine((recipe, ctx) => {
  const names = groupNames(recipe.record);
  const unknown = names.filter((name) => !isField(name));
  if (unknown.length > 0) {
    ctx.addIssue({ code: "custom", message: `Unknown groups: ${unknown.join(", ")}` });
  }
  for (const required of ["tradeDate", "type", "amount"]) {
    if (!names.includes(required)) {
      ctx.addIssue({ code: "custom", message: `record does not name the group ${required}` });
    }
  }
  if (
    recipe.unsignedAmount &&
    recipe.types.some((t) => MOVES_MONEY.has(t.type) && t.sign === null)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "With an unsigned amount, every type that moves money must have a sign",
    });
  }
});

export type BrokerRecord = z.infer<typeof BaseBrokerRecord>;

// eslint-disable-next-line anti-slop/no-unknown-parameters
const parseBrokerRecord = (raw: unknown): BrokerRecord => BrokerRecordSchema.parse(raw);

const linesOf = (text: string): string[] =>
  text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((line) => (line.trim() === "" ? "" : line.trimEnd()));

type Block = { readonly line: number; readonly lines: readonly string[] };

const blocksOf = (
  lines: readonly { readonly line: number; readonly text: string }[],
  recordStart: RegExp | null,
): Block[] => {
  const blocks: Block[] = [];
  let current: { line: number; lines: string[] } | null = null;
  for (const { line, text } of lines) {
    const separator = text === "";
    const opens = recordStart === null ? !separator && current === null : recordStart.test(text);
    if (separator && recordStart === null) {
      if (current !== null) blocks.push(current);
      current = null;
      continue;
    }
    if (separator) continue;
    if (opens || current === null) {
      if (current !== null) blocks.push(current);
      current = { line, lines: [] };
    }
    current.lines.push(text);
  }
  if (current !== null) blocks.push(current);
  return blocks;
};

export const runBrokerRecord = (
  text: string,
  recipe: BrokerRecord,
  known: KnownInstruments,
  accountId: number,
): TableRun => {
  const skip = recipe.skip.map((source) => new RegExp(source, "u"));
  const recordStart = recipe.recordStart === null ? null : new RegExp(recipe.recordStart, "u");
  const record = new RegExp(`^(?:${recipe.record})$`, "u");
  const fields = groupNames(recipe.record).filter(isField);

  const kept = linesOf(text).flatMap((value, index) =>
    value !== "" && skip.some((pattern) => pattern.test(value))
      ? []
      : [{ line: index + 1, text: value }],
  );
  const rows: RawRow[] = [];
  const blocks = blocksOf(kept, recordStart);
  // A skipped line between two records with both a date and an amount fails the recipe: a skip pattern must not hide a transaction.
  const first = blocks[0]?.line ?? Number.POSITIVE_INFINITY;
  const last = blocks.at(-1)?.line ?? Number.NEGATIVE_INFINITY;
  const skippedTransactions: CsvProblem[] = linesOf(text).flatMap((value, index) =>
    index + 1 > first &&
    index + 1 < last &&
    LOOKS_LIKE_TRANSACTION.every((sign) => sign.test(value)) &&
    skip.some((pattern) => pattern.test(value))
      ? [
          {
            line: index + 1,
            message: `A skipped line looks like a transaction: ${value}`,
            raw: value,
          },
        ]
      : [],
  );
  const problems: CsvProblem[] = [...skippedTransactions];
  for (const block of blocks) {
    const joined = block.lines.join("\n");
    const match = record.exec(joined);
    if (match === null) {
      problems.push({ line: block.line, message: `Record not read: ${joined}`, raw: joined });
      continue;
    }
    try {
      const values: Record<string, string> = {};
      for (const field of fields)
        values[field] = readField(field, match.groups?.[field] ?? "", recipe);
      rows.push({ line: block.line, values, cells: [] });
    } catch (cause) {
      problems.push({
        line: block.line,
        message: cause instanceof Error ? cause.message : "Failed to process the record",
        raw: joined,
      });
    }
  }

  const { draft, failures } = mapNormalised(
    rows,
    problems,
    mappingOf(recipe, fields),
    known,
    accountId,
  );
  return { draft, rows, missingHeaders: [], failures };
};

const INSTRUCTIONS = [
  FINNISH_CONTEXT,
  "You receive a broker's transaction list as text: a table copied from a web service where every value is on its own line, or text extracted from a PDF. Describe its format as a JSON object that the program uses to read every transaction.",
  "skip: lines removed first (column headings, other text on the page). Do not remove lines that hold transaction data.",
  "recordStart: the line a transaction starts at, or null if transactions are separated by a blank line.",
  "record: a regular expression matching ONE WHOLE transaction, its lines joined with \\n. Named groups are fields: tradeDate, type, instrumentName, isin, quantity, unitPrice, fee, currency, amount, costBasis, note, priceCurrency, portfolio, externalId. Required: tradeDate, type, amount. An optional line: (?:\\n(?<fee>[^\\n]+))?",
  "Not all transactions have the same lines: for example a share exchange, consolidation or detachment of subscription rights may have only a name, type, date and quantity with no money lines at all. Then make the price, fee and total lines optional together, e.g. (?:\\n(?<unitPrice>[^\\n]+)(?:\\n(?<fee>[^\\n]+))?\\n(?<amount>[^\\n]+))?",
  TYPE_RULES,
  "unsignedAmount: true if buys and sells print with the same sign; then sign gives the direction of the money (buy -1, sell 1).",
  "money gives the decimal and thousands separators, the negative notation, and in the strip list the units to remove (e.g. kpl, EUR).",
].join("\n");

/** The opening lines plus one record of every other length: a corporate action may first appear hundreds of lines in. */
export const sampleOf = (text: string): string => {
  const lines = linesOf(text);
  const opening = lines.slice(0, SAMPLE_LINES);
  const records = lines.join("\n").split(/\n{2,}/);
  // The opening's last record may be cut off mid-way, so its length says nothing.
  const seen = new Set(
    opening
      .join("\n")
      .split(/\n{2,}/)
      .slice(0, -1)
      .map((r) => r.split("\n").length),
  );
  const extra = records.filter((record) => {
    const length = record.split("\n").length;
    if (seen.has(length)) return false;
    seen.add(length);
    return true;
  });
  return extra.length === 0
    ? opening.join("\n")
    : `${opening.join("\n")}\n\nElsewhere in the text there are also these:\n\n${extra.join("\n\n")}`;
};

const brokerRecordKey = (text: string): string =>
  fingerprint(
    "broker-record",
    linesOf(text).filter((line) => line !== ""),
  );

export const readBrokerRecordByRecipe = async (
  text: string,
  userId: string,
  client: ChatClient,
  known: KnownInstruments,
  accountId: number,
): Promise<TableRun> => {
  const key = brokerRecordKey(text);
  const run = (recipe: BrokerRecord) => runBrokerRecord(text, recipe, known, accountId);
  const stored = await loadParsed(userId, key, parseBrokerRecord);
  if (stored !== null) {
    const result = run(stored);
    if (passes(result)) return result;
    await forgetRecipe(userId, key);
  }
  const asked = await askForRecipe({
    client,
    instructions: INSTRUCTIONS,
    sample: sampleOf(text),
    schema: BrokerRecordSchema,
    run,
    judge: (result) => ({
      passed: passes(result),
      score: result.draft.txns.length,
      feedback: feedbackOf(result),
    }),
  });
  if (asked === null) throw new Error(NOT_READABLE);
  if (asked.verified) await saveRecipe(userId, key, asked.recipe);
  return asked.run;
};
