import { z } from "zod";

import type { ChatClient } from "../../chat/runner.ts";
import type { CanonicalField, CsvProblem, RawRow } from "../types.ts";
import { askForRecipe } from "./ask.ts";
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
import { mayBacktrackForever } from "./pattern-safety.ts";
import { forgetRecipe, loadParsed, saveRecipe } from "./store.ts";
import { MAX_PATTERN_LENGTH, MoneyFormatSchema } from "./types.ts";

/** A date and an amount on one line: what a skipped transaction looks like. */
const LOOKS_LIKE_TRANSACTION = [
  /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/u,
  /\d[.,]\d{2}\b/u,
];

/** Lines the model is shown from the start of the text. */
const SAMPLE_LINES = 120;
const NOT_READABLE = "Tekstiä ei tunnistettu tapahtumaluetteloksi";

/** A pattern the model wrote: capped, compilable, and not shaped to backtrack forever. */
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

const FIELD_NAMES: ReadonlySet<string> = new Set(FIELDS);
const isField = (name: string): name is CanonicalField => FIELD_NAMES.has(name);

const groupNames = (source: string): string[] =>
  [...source.matchAll(/\(\?<([A-Za-z][A-Za-z0-9]*)>/g)].map((m) => m[1] ?? "");

/**
 * Transactions printed one value per line, as a web table copies or a PDF
 * extracts. Records are cut at a start pattern, or at blank lines when there is
 * none; `record` then reads one whole record, its named groups being the
 * transaction's fields.
 */
const BaseBrokerRecord = z
  .object({
    kind: z.literal("broker-record"),
    /** Lines dropped before records are cut: column headings, page furniture. */
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
    ctx.addIssue({ code: "custom", message: `Tuntemattomat ryhmät: ${unknown.join(", ")}` });
  }
  for (const required of ["tradeDate", "type", "amount"]) {
    if (!names.includes(required)) {
      ctx.addIssue({ code: "custom", message: `record ei nimeä ryhmää ${required}` });
    }
  }
  if (
    recipe.unsignedAmount &&
    recipe.types.some((t) => MOVES_MONEY.has(t.type) && t.sign === null)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "Etumerkittömällä summalla jokaisella rahaa liikuttavalla lajilla on oltava sign",
    });
  }
});

export type BrokerRecord = z.infer<typeof BaseBrokerRecord>;

// eslint-disable-next-line anti-slop/no-unknown-parameters
const parseBrokerRecord = (raw: unknown): BrokerRecord => BrokerRecordSchema.parse(raw);

/** A whitespace-only line is a separator, not content. */
const linesOf = (text: string): string[] =>
  text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((line) => (line.trim() === "" ? "" : line.trimEnd()));

type Block = { readonly line: number; readonly lines: readonly string[] };

/** Records as runs of kept lines, cut at a start pattern or at separators. */
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
  // A skip pattern that ate a transaction would hide it from every other
  // check, so a skipped line between two records that carries both a date and
  // an amount fails the recipe. Above the first record and below the last are
  // balances and totals; anywhere, a page number or printed date alone is
  // furniture.
  const first = blocks[0]?.line ?? Number.POSITIVE_INFINITY;
  const last = blocks.at(-1)?.line ?? Number.NEGATIVE_INFINITY;
  const skippedTransactions: CsvProblem[] = linesOf(text).flatMap((value, index) =>
    index + 1 > first &&
    index + 1 < last &&
    LOOKS_LIKE_TRANSACTION.every((sign) => sign.test(value)) &&
    skip.some((pattern) => pattern.test(value))
      ? [{ line: index + 1, message: `Ohitettu rivi näyttää tapahtumalta: ${value}`, raw: value }]
      : [],
  );
  const problems: CsvProblem[] = [...skippedTransactions];
  for (const block of blocks) {
    const joined = block.lines.join("\n");
    const match = record.exec(joined);
    if (match === null) {
      problems.push({ line: block.line, message: `Tietuetta ei luettu: ${joined}`, raw: joined });
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
        message: cause instanceof Error ? cause.message : "Tietueen käsittely epäonnistui",
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
  "Saat välittäjän tapahtumaluettelon tekstinä: verkkopalvelusta kopioitu taulukko, jossa jokainen arvo on omalla rivillään, tai PDF:stä poimittu teksti. Kuvaa sen muoto JSON-oliona, jolla ohjelma lukee jokaisen tapahtuman.",
  "skip: rivit jotka poistetaan ensin (sarakeotsikot, sivun muut tekstit). Älä poista rivejä joissa on tapahtuman tietoja.",
  "recordStart: rivi josta tapahtuma alkaa, tai null jos tapahtumat erottaa tyhjä rivi.",
  "record: säännöllinen lauseke joka vastaa YHTÄ KOKONAISTA tapahtumaa, rivit yhdistettynä \\n-merkillä. Nimetyt ryhmät ovat kenttiä: tradeDate, type, instrumentName, isin, quantity, unitPrice, fee, currency, amount, costBasis, note, priceCurrency, portfolio, externalId. Pakolliset: tradeDate, type, amount. Valinnainen rivi: (?:\\n(?<fee>[^\\n]+))?",
  "Kaikilla tapahtumilla ei ole samoja rivejä: esimerkiksi osakkeiden vaihdossa, yhdistelyssä tai merkintäoikeuksien irrotuksessa voi olla pelkkä nimi, laji, päivä ja kappalemäärä ilman yhtään rahariviä. Tee silloin hinta-, kulu- ja summarivit yhdessä valinnaisiksi, esim. (?:\\n(?<unitPrice>[^\\n]+)(?:\\n(?<fee>[^\\n]+))?\\n(?<amount>[^\\n]+))?",
  TYPE_RULES,
  "unsignedAmount: true jos osto ja myynti tulostuvat samanmerkkisinä; silloin sign kertoo rahan suunnan (osto -1, myynti 1).",
  "money kertoo desimaali- ja tuhaterottimen, negatiivisen merkinnän ja strip-listassa yksiköt jotka poistetaan (esim. kpl, EUR).",
].join("\n");

/**
 * The text's opening lines, plus one record of every other length found
 * further down. A corporate action with no money lines may first appear
 * hundreds of lines in; shown only the opening, a model writes a record
 * pattern that cannot read it.
 */
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
    : `${opening.join("\n")}\n\nMuualla tekstissä myös näin:\n\n${extra.join("\n\n")}`;
};

export const brokerRecordKey = (text: string): string =>
  fingerprint(
    "broker-record",
    linesOf(text).filter((line) => line !== ""),
  );

/**
 * Transactions printed one value per line. A stored recipe for this layout is
 * tried first; one that no longer reads every record is forgotten and
 * described again. Only a recipe that read every record is stored.
 */
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
