import { z } from "zod";

import { type ChatClient, type ChatMessage } from "../../chat/runner.ts";
import { type BankRow, type BankStatement, noteOf, rowType } from "../bank-statement.ts";
import { parseCsv } from "../csv.ts";
import type { BrokerCsvConfig, RawRow } from "../types.ts";
import { readDate } from "./date-format.ts";
import { fingerprint } from "./fingerprint.ts";
import { readAmount, readTwoColumn } from "./money-format.ts";
import { forgetRecipe, loadParsed, saveRecipe } from "./store.ts";
import { MoneyFormatSchema } from "./types.ts";

const MODEL = "claude-opus-5-5";
const MAX_TOKENS = 16000;
/** Attempts at a recipe before settling for the best one, unsaved. */
const MAX_ATTEMPTS = 3;
/** Data lines the model is shown: enough to see every shape, few enough to stay cheap. */
const SAMPLE_ROWS = 30;
/** Failed rows quoted back to the model on a retry. */
const QUOTED_FAILURES = 10;

const NOT_A_STATEMENT = "Tiedostoa ei tunnistettu tiliotteeksi";

const Header = z.string().min(1).nullable();

/**
 * A bank CSV described by header name. Row cutting is the CSV's own, so all a
 * recipe adds is which column means what and how dates and money are written.
 * Every key is required (nullable where a statement may lack it): structured
 * output fills a required field rather than leaving it out.
 */
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

export const BankCsvRecipeSchema = BaseCsvRecipe.superRefine((recipe, ctx) => {
  const { amount, debit, credit } = recipe.columns;
  if ((amount === null) === (debit === null || credit === null)) {
    ctx.addIssue({
      code: "custom",
      message: "Nimeä joko amount tai debit ja credit, ei molempia eikä kumpaakaan",
    });
  }
});

export type BankCsvRecipe = z.infer<typeof BaseCsvRecipe>;

// eslint-disable-next-line anti-slop/no-unknown-parameters
const parseCsvRecipe = (raw: unknown): BankCsvRecipe => BankCsvRecipeSchema.parse(raw);

/**
 * The bytes' encoding, decided here rather than by the model: a byte-order
 * mark settles it, and text that is not valid UTF-8 is a legacy Windows export.
 */
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

const linesOf = (bytes: ArrayBuffer): string[] =>
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

export type CsvRun = BankStatement & {
  /** Headers the recipe names that the file does not have. */
  readonly missingHeaders: readonly string[];
};

/** Reads every row the recipe can; a row it cannot is a problem, never a guess. */
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
        message: cause instanceof Error ? cause.message : "Rivin käsittely epäonnistui",
      });
    }
  }
  return { rows, problems, missingHeaders };
};

/**
 * A CSV prints no balance, so the check is weaker than a PDF's arithmetic:
 * every header the recipe names exists, and every row reads. One unread row
 * fails it -- a statement that silently drops a line is the error to avoid.
 */
const passes = (run: CsvRun): boolean =>
  run.missingHeaders.length === 0 && run.problems.length === 0 && run.rows.length > 0;

const INSTRUCTIONS = [
  "Saat pankin tiliotteen CSV-tiedoston alun. Kuvaa sen muoto JSON-oliona, jolla ohjelma lukee jokaisen rivin.",
  "delimiter: sarake-erotin. columns: otsikkorivin sarakkeiden nimet täsmälleen kuten ne on kirjoitettu.",
  "date on kirjauspäivän sarake. Summalle nimeä joko amount (etumerkillinen summa) tai debit ja credit (kaksi etumerkitöntä saraketta), ei molempia; käyttämätön on null.",
  "label on tapahtuman laji tai selite, counterparty saaja tai maksaja, message viesti, externalId tapahtuman yksilöivä tunniste (esim. arkistointitunnus). Puuttuva on null.",
  "dateFormat kertoo päivän osien järjestyksen. money kertoo desimaali- ja tuhaterottimen sekä miten negatiivinen summa merkitään.",
  "interestLabels: lajit, joilla pankki maksaa korkoa tilille (esim. KORKO). Tyhjä lista jos ei ole.",
  "Älä arvaa sarakkeen nimeä: käytä vain otsikkorivillä olevia.",
].join("\n");

const failuresOf = (run: CsvRun): string => {
  if (run.missingHeaders.length > 0) {
    return `Näitä sarakkeita ei ole otsikkorivillä: ${run.missingHeaders.join(", ")}`;
  }
  if (run.rows.length === 0 && run.problems.length === 0) return "Yhtään riviä ei luettu.";
  return run.problems
    .slice(0, QUOTED_FAILURES)
    .map((problem) => `rivi ${problem.line}: ${problem.message}`)
    .join("\n");
};

/** The reply's JSON, or null when the model wrote something else. */
const recipeOf = (text: string): BankCsvRecipe | null => {
  try {
    const parsed = BankCsvRecipeSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * Asks for a recipe, runs it over the whole file, and on failure shows the
 * model what went wrong. The conversation only grows, so each retry sees its
 * own earlier answer and the rows that answer could not read.
 */
export const generateCsvRecipe = async (
  bytes: ArrayBuffer,
  client: ChatClient,
): Promise<{ recipe: BankCsvRecipe; run: CsvRun; verified: boolean } | null> => {
  const sample = linesOf(bytes)
    .slice(0, SAMPLE_ROWS + 1)
    .join("\n");
  let messages: readonly ChatMessage[] = [
    { role: "system", content: INSTRUCTIONS },
    { role: "user", content: sample },
  ];
  let best: { recipe: BankCsvRecipe; run: CsvRun } | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const reply = await client.run({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages,
      tools: [],
      response_format: { type: "json_schema", json_schema: z.toJSONSchema(BaseCsvRecipe) },
    });
    const recipe = recipeOf(reply.text);
    const run = recipe === null ? null : runCsvRecipe(bytes, recipe);
    if (recipe !== null && run !== null && passes(run)) return { recipe, run, verified: true };
    if (recipe !== null && run !== null && run.rows.length > (best?.run.rows.length ?? 0)) {
      best = { recipe, run };
    }
    const feedback =
      run === null
        ? "Vastaus ei ollut kelvollinen kuvaus. Vastaa pelkällä JSON-oliolla."
        : failuresOf(run);
    messages = [
      ...messages,
      { role: "assistant", content: reply.text },
      {
        role: "user",
        content: `Kuvaus ei vielä toimi:\n${feedback}\nKorjaa ja vastaa koko kuvauksella.`,
      },
    ];
  }
  return best === null ? null : { ...best, verified: false };
};

/** The layout's identity: its header row, digits blanked like a PDF's first lines. */
export const csvRecipeKey = (bytes: ArrayBuffer): string =>
  fingerprint("bank-csv", linesOf(bytes).slice(0, 1));

/**
 * A bank CSV no built-in format knows. A stored recipe for this header is tried
 * first; one that no longer reads every row is forgotten and described again.
 * Only a recipe that read every row is stored -- a partial one still fills the
 * preview, with its unread rows listed, but is asked for again next time.
 */
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
