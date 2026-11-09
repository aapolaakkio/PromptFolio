import { z } from "zod";

import type { ChatClient } from "../../chat/runner.ts";
import { type BankRow, type BankStatement, noteOf, rowType } from "../bank-statement.ts";
import { parseCsv } from "../csv.ts";
import type { BrokerCsvConfig, RawRow } from "../types.ts";
import { askForRecipe, FINNISH_CONTEXT } from "./ask.ts";
import { readDate } from "./date-format.ts";
import { fingerprint } from "./fingerprint.ts";
import { readAmount, readTwoColumn } from "./money-format.ts";
import { forgetRecipe, loadParsed, saveRecipe } from "./store.ts";
import { MoneyFormatSchema } from "./types.ts";

const SAMPLE_ROWS = 30;
const QUOTED_FAILURES = 10;

const NOT_A_STATEMENT = "The file was not recognised as a bank statement";

const Header = z.string().min(1).nullable();

/** Every key is required (nullable where absent): structured output fills required fields. */
const BaseCsvRecipe = z
  .object({
    kind: z.literal("bank-csv"),
    delimiter: z.enum([";", ",", "\t", "|"]),
    columns: z
      .object({
        date: z.string().min(1),
        amount: Header,
        debit: Header,
        credit: Header,
        label: Header,
        counterparty: Header,
        message: Header,
        externalId: Header,
      })
      .strict(),
    dateFormat: z.enum(["d.m.yyyy", "dd.mm.yyyy", "m.d.yyyy", "yyyy-mm-dd"]),
    money: MoneyFormatSchema,
    interestLabels: z.array(z.string().min(1)).max(10),
  })
  .strict();

const BankCsvRecipeSchema = BaseCsvRecipe.superRefine((recipe, ctx) => {
  const { amount, debit, credit } = recipe.columns;
  if ((amount === null) === (debit === null || credit === null)) {
    ctx.addIssue({
      code: "custom",
      message: "Name either amount or debit and credit, not both and not neither",
    });
  }
});

export type BankCsvRecipe = z.infer<typeof BaseCsvRecipe>;

// eslint-disable-next-line anti-slop/no-unknown-parameters
const parseCsvRecipe = (raw: unknown): BankCsvRecipe => BankCsvRecipeSchema.parse(raw);

/** A byte-order mark settles the encoding; non-UTF-8 text is a legacy Windows export. */
export const encodingOf = (bytes: ArrayBuffer): BrokerCsvConfig["encoding"] => {
  const head = new Uint8Array(bytes.slice(0, 2));
  if (head[0] === 0xff && head[1] === 0xfe) return "utf-16le";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "utf-8";
  } catch {
    return "latin1";
  }
};

export const linesOf = (bytes: ArrayBuffer): string[] =>
  new TextDecoder(encodingOf(bytes))
    .decode(bytes)
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");

const cell = (row: RawRow, header: string | null): string =>
  header === null ? "" : (row.values[header] ?? "").trim();

const readRow = (row: RawRow, recipe: BankCsvRecipe): BankRow => {
  const { columns } = recipe;
  const date = readDate(cell(row, columns.date), recipe.dateFormat);
  const amount =
    columns.amount === null
      ? readTwoColumn(cell(row, columns.debit), cell(row, columns.credit), recipe.money)
      : readAmount(cell(row, columns.amount), recipe.money);
  const label = cell(row, columns.label);
  const counterparty = cell(row, columns.counterparty);
  const externalId = cell(row, columns.externalId);
  return {
    line: row.line,
    date,
    type: rowType(label, amount, recipe.interestLabels),
    amount,
    counterparty,
    note: noteOf([label, counterparty, cell(row, columns.message)]),
    externalId: externalId === "" ? null : externalId,
  };
};

type CsvRun = BankStatement & {
  readonly missingHeaders: readonly string[];
};

export const runCsvRecipe = (bytes: ArrayBuffer, recipe: BankCsvRecipe): CsvRun => {
  const parsed = parseCsv(bytes, { encoding: encodingOf(bytes), delimiter: recipe.delimiter });
  const present = new Set(parsed.headers);
  const missingHeaders = Object.values(recipe.columns).filter(
    (header): header is string => header !== null && !present.has(header),
  );
  const rows: BankRow[] = [];
  const problems = parsed.problems.map(({ line, message }) => ({ line, message }));
  if (missingHeaders.length > 0) return { rows, problems, missingHeaders };
  for (const row of parsed.rows) {
    try {
      rows.push(readRow(row, recipe));
    } catch (cause) {
      problems.push({
        line: row.line,
        message: cause instanceof Error ? cause.message : "Failed to process the row",
      });
    }
  }
  return { rows, problems, missingHeaders };
};

const passes = (run: CsvRun): boolean =>
  run.missingHeaders.length === 0 && run.problems.length === 0 && run.rows.length > 0;

const INSTRUCTIONS = [
  FINNISH_CONTEXT,
  "You receive the start of a bank statement CSV file. Describe its format as a JSON object that the program uses to read every row.",
  "delimiter: the column delimiter. columns: the names of the header-row columns exactly as written.",
  "date is the booking date column. For the amount name either amount (a signed amount) or debit and credit (two unsigned columns), not both; the unused one is null.",
  "label is the transaction type or description, counterparty the payee or payer, message the message, externalId a value that uniquely identifies the transaction (e.g. an archive id). A missing one is null.",
  "dateFormat gives the order of the date parts. money gives the decimal and thousands separators and how a negative amount is written.",
  "interestLabels: the types with which the bank pays interest into the account (e.g. KORKO, Finnish for interest). An empty list if there are none.",
  "Do not guess a column name: use only those in the header row.",
].join("\n");

const failuresOf = (run: CsvRun): string => {
  if (run.missingHeaders.length > 0) {
    return `These columns are not in the header row: ${run.missingHeaders.join(", ")}`;
  }
  if (run.rows.length === 0 && run.problems.length === 0) return "No rows were read.";
  return run.problems
    .slice(0, QUOTED_FAILURES)
    .map((problem) => `line ${problem.line}: ${problem.message}`)
    .join("\n");
};

const generateCsvRecipe = (bytes: ArrayBuffer, client: ChatClient) =>
  askForRecipe({
    client,
    instructions: INSTRUCTIONS,
    sample: linesOf(bytes)
      .slice(0, SAMPLE_ROWS + 1)
      .join("\n"),
    schema: BankCsvRecipeSchema,
    run: (recipe: BankCsvRecipe) => runCsvRecipe(bytes, recipe),
    judge: (run) => ({ passed: passes(run), score: run.rows.length, feedback: failuresOf(run) }),
  });

const csvRecipeKey = (bytes: ArrayBuffer): string =>
  fingerprint("bank-csv", linesOf(bytes).slice(0, 1));

export const readBankCsvByRecipe = async (
  bytes: ArrayBuffer,
  userId: string,
  client: ChatClient,
): Promise<BankStatement> => {
  const key = csvRecipeKey(bytes);
  const stored = await loadParsed(userId, key, parseCsvRecipe);
  if (stored !== null) {
    const run = runCsvRecipe(bytes, stored);
    if (passes(run)) return run;
    await forgetRecipe(userId, key);
  }
  const generated = await generateCsvRecipe(bytes, client);
  if (generated === null) throw new Error(NOT_A_STATEMENT);
  if (generated.verified) await saveRecipe(userId, key, generated.recipe);
  return generated.run;
};
