import { z } from "zod";

import { EUR, formatMoney, parseMoney } from "../../../core/money.ts";
import type { ChatClient } from "../../chat/runner.ts";
import { parseCsv } from "../csv.ts";
import { askForRecipe } from "./ask.ts";
import { readDate } from "./date-format.ts";
import { fingerprint } from "./fingerprint.ts";
import { readDecimal } from "./money-format.ts";
import { mayBacktrackForever } from "./pattern-safety.ts";
import { forgetRecipe, loadParsed, saveRecipe } from "./store.ts";
import { MAX_PATTERN_LENGTH, MoneyFormatSchema } from "./types.ts";

const SAMPLE_LINES = 120;
const QUOTED_FAILURES = 10;
const NOT_READABLE = "Tekstiä ei tunnistettu omistusluetteloksi";

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
  )
  .refine((source) => !mayBacktrackForever(source), {
    message: "Säännöllinen lauseke voi jäädä jumiin (sisäkkäinen toisto)",
  });

const HOLDING_FIELDS = ["name", "isin", "quantity", "marketValue", "cost", "currency"] as const;
type HoldingField = (typeof HOLDING_FIELDS)[number];
const FIELD_NAMES: ReadonlySet<string> = new Set(HOLDING_FIELDS);
const isField = (name: string): name is HoldingField => FIELD_NAMES.has(name);

const groupNames = (source: string): string[] =>
  [...source.matchAll(/\(\?<([A-Za-z][A-Za-z0-9]*)>/g)].map((m) => m[1] ?? "");

/**
 * A holdings statement: a table read by header, or values one per line read
 * record by record, as OP's web view copies and a PDF extracts. The statement's
 * own date and printed total are read by patterns over the whole text, each
 * naming its figure as the group `value`.
 */
const BaseHoldings = z
  .object({
    kind: z.literal("holdings"),
    layout: z.enum(["table", "record"]),
    /** Table layout: the column separator. */
    delimiter: z.enum([";", ",", "\t", "|"]).nullable(),
    /** Table layout: which header is which field. */
    columns: z
      .array(z.object({ field: z.enum(HOLDING_FIELDS), header: z.string().min(1) }).strict())
      .max(HOLDING_FIELDS.length),
    /** Lines dropped first -- headings, section titles, a table's title or total. */
    skip: z.array(Pattern).max(40),
    /** Record layout: the line a holding starts on. */
    recordStart: Pattern.nullable(),
    /** Record layout: one whole holding, lines joined with \n, fields as named groups. */
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
    ctx.addIssue({ code: "custom", message: "Taulukolla on oltava delimiter" });
  }
  if (recipe.layout === "record" && (recipe.record === null || recipe.recordStart === null)) {
    ctx.addIssue({ code: "custom", message: "Tietueella on oltava recordStart ja record" });
  }
  const fields = fieldsOf(recipe);
  for (const required of ["name", "quantity", "marketValue"] as const) {
    if (!fields.includes(required)) {
      ctx.addIssue({ code: "custom", message: `Kenttä puuttuu: ${required}` });
    }
  }
});

export type HoldingsRecipe = z.infer<typeof BaseHoldings>;

// eslint-disable-next-line anti-slop/no-unknown-parameters
const parseHoldingsRecipe = (raw: unknown): HoldingsRecipe => HoldingsRecipeSchema.parse(raw);

export type Holding = {
  readonly name: string;
  readonly isin: string | null;
  /** A plain decimal, every printed decimal kept. */
  readonly quantity: string;
  /** In cents, as a plain decimal: a broker's extra decimals are false precision. */
  readonly marketValueEur: string;
  readonly costEur: string;
  readonly currency: string;
};

export type HoldingsRun = {
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
  if (name === "") throw new Error("Nimi puuttuu");
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
  // A title or a total printed around the table is dropped before the header
  // row is looked for, the same `skip` the record layout uses.
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
          message: `Näitä sarakkeita ei ole otsikkorivillä: ${missing.map((c) => c.header).join(", ")}`,
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
      problems.push({ line: block.line, message: `Riviä ei luettu: ${joined}`, raw: joined });
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
        message: cause instanceof Error ? cause.message : "Riviä ei luettu",
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

/**
 * Every row read, and -- when the statement prints a total -- the holdings add
 * up to it to the cent. The total is the real check: a recipe that drops or
 * misreads a holding cannot also reach the printed figure.
 */
const judge = (run: HoldingsRun, needsAsOf: boolean) => {
  const reasons: string[] = run.problems
    .slice(0, QUOTED_FAILURES)
    .map((p) => `rivi ${p.line}: ${p.message}`);
  if (run.holdings.length === 0) reasons.push("Yhtään omistusta ei luettu.");
  if (needsAsOf && run.asOf === null) reasons.push("asOf ei löytänyt otteen päivää.");
  if (run.statedTotalEur !== null && sumOf(run.holdings) !== run.statedTotalEur) {
    reasons.push(
      `Omistusten summa ${sumOf(run.holdings)} ei vastaa otteen kokonaisarvoa ${run.statedTotalEur}.`,
    );
  }
  return { passed: reasons.length === 0, score: run.holdings.length, feedback: reasons.join("\n") };
};

const INSTRUCTIONS = [
  "Saat arvopapereiden omistusotteen tekstinä: taulukko (CSV tai kopioitu), verkkopalvelusta kopioitu näkymä jossa jokainen arvo on omalla rivillään, tai PDF:stä poimittu teksti. Kuvaa sen muoto JSON-oliona, jolla ohjelma lukee jokaisen omistuksen.",
  "layout: table jos tekstissä on otsikkorivi ja sarakkeet; silloin delimiter ja columns (otsikot täsmälleen kuten kirjoitettu). Muuten record: skip poistaa otsikot ja väliotsikot, recordStart on rivi josta omistus alkaa, record on säännöllinen lauseke joka vastaa yhtä kokonaista omistusta (rivit yhdistettynä \\n-merkillä).",
  "Kentät (columns tai recordin nimetyt ryhmät): name, isin, quantity kappalemäärä, marketValue markkina-arvo, cost hankinta-arvo, currency. Pakolliset: name, quantity, marketValue.",
  "asOf: säännöllinen lauseke jonka ryhmä value on otteen päivä, tai null. total: lauseke jonka ryhmä value on otteen ilmoittama kokonaisarvo, tai null jos sitä ei ole.",
  "money kertoo desimaali- ja tuhaterottimen, negatiivisen merkinnän ja strip-listassa yksiköt jotka poistetaan (esim. kpl, EUR).",
].join("\n");

export const holdingsRecipeKey = (text: string): string =>
  fingerprint(
    "holdings",
    text.split(/\r?\n/).filter((line) => line.trim() !== ""),
  );

/**
 * A holdings statement, read by a recipe: a stored one for this layout when it
 * still reads everything, otherwise one the model writes. `needsAsOf` is for a
 * statement whose date only the document itself states.
 */
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

/**
 * A holdings file's text. A byte-order mark settles the encoding; anything
 * else is read as UTF-8.
 */
export const decodeHoldingsFile = (bytes: Uint8Array): string => {
  const utf16le = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
  const utf16be = bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff;
  const encoding = utf16le ? "utf-16le" : utf16be ? "utf-16be" : "utf-8";
  return new TextDecoder(encoding).decode(bytes).replace(/^﻿/, "");
};
