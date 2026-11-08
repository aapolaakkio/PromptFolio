import { z } from "zod";

import type { ChatClient } from "../../chat/runner.ts";
import { parseCsv } from "../csv.ts";
import { type Draft, mapRows } from "../map.ts";
import type { CanonicalField, CsvProblem, FieldMapping, RawRow } from "../types.ts";
import { askForRecipe } from "./ask.ts";
import { encodingOf, linesOf } from "./csv-recipe.ts";
import { readDate } from "./date-format.ts";
import { fingerprint } from "./fingerprint.ts";
import { readDecimal } from "./money-format.ts";
import { forgetRecipe, loadParsed, saveRecipe } from "./store.ts";
import { MoneyFormatSchema } from "./types.ts";

/** Data lines the model is shown, beside every column's distinct labels. */
const SAMPLE_ROWS = 30;
/** A column with more distinct values than this holds data, not labels. */
const MAX_LABELS = 40;
const QUOTED_FAILURES = 10;
const NOT_READABLE = "Tiedostoa ei tunnistettu tapahtumaluetteloksi";

export const FIELDS = [
  "externalId",
  "tradeDate",
  "type",
  "instrumentName",
  "isin",
  "quantity",
  "unitPrice",
  "fee",
  "currency",
  "amount",
  "costBasis",
  "note",
  "priceCurrency",
  "portfolio",
] as const satisfies readonly CanonicalField[];

/** Read through the recipe's money format into a plain decimal before mapping. */
const NUMERIC: ReadonlySet<CanonicalField> = new Set([
  "quantity",
  "unitPrice",
  "fee",
  "amount",
  "costBasis",
]);

export const TYPES = [
  "BUY",
  "SELL",
  "DIVIDEND",
  "FEE",
  "INTEREST",
  "DEPOSIT",
  "WITHDRAWAL",
  "SPLIT",
  "TRANSFER_IN",
  "TRANSFER_OUT",
] as const;

/**
 * A broker's transaction table, described by header. Labels are the part with
 * judgement in it: each one the file uses is mapped to a transaction type or
 * deliberately ignored with a reason, and an unmapped label fails the check
 * rather than being guessed at import time.
 */
/**
 * Types whose amount is cash in or out, and so need a sign when the broker
 * prints amounts unsigned. A split or a transfer of units moves no cash.
 */
export const MOVES_MONEY: ReadonlySet<string> = new Set([
  "BUY",
  "SELL",
  "DIVIDEND",
  "FEE",
  "INTEREST",
  "DEPOSIT",
  "WITHDRAWAL",
]);

export const TypeRuleSchema = z
  .object({
    label: z.string().min(1),
    type: z.enum([...TYPES, "IGNORE"]),
    /** Why an IGNORE row is skipped, shown on the review screen. */
    reason: z.string().nullable(),
    sign: z.union([z.literal(1), z.literal(-1)]).nullable(),
  })
  .strict();

const BaseBrokerTable = z
  .object({
    kind: z.literal("broker-table"),
    delimiter: z.enum([";", ",", "\t", "|"]),
    columns: z
      .array(
        z
          .object({
            field: z.enum(FIELDS),
            header: z.string().min(1),
            /** 1-based column, only for a header the file repeats. */
            position: z.number().int().min(1).nullable(),
          })
          .strict(),
      )
      .max(FIELDS.length),
    dateFormat: z.enum(["d.m.yyyy", "dd.mm.yyyy", "m.d.yyyy", "yyyy-mm-dd"]),
    money: MoneyFormatSchema,
    /** True when the amount is printed unsigned, so each type carries its sign. */
    unsignedAmount: z.boolean(),
    types: z.array(TypeRuleSchema).max(80),
  })
  .strict();

export const BrokerTableSchema = BaseBrokerTable.superRefine((recipe, ctx) => {
  const fields = recipe.columns.map((column) => column.field);
  for (const required of ["tradeDate", "type", "amount"] as const) {
    if (!fields.includes(required)) {
      ctx.addIssue({ code: "custom", message: `Sarake puuttuu: ${required}` });
    }
  }
  if (new Set(fields).size !== fields.length) {
    ctx.addIssue({ code: "custom", message: "Sama kenttä on nimetty kahdesti" });
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

export type BrokerTable = z.infer<typeof BaseBrokerTable>;

// eslint-disable-next-line anti-slop/no-unknown-parameters
const parseBrokerTable = (raw: unknown): BrokerTable => BrokerTableSchema.parse(raw);

/**
 * The recipe as `mapRows` takes it. Rows reach `mapRows` already normalised
 * and keyed by field name, so the mapping's columns are the field names
 * themselves and its dates are ISO.
 */
export const mappingOf = (
  recipe: Pick<BrokerTable, "types" | "unsignedAmount">,
  fields: readonly CanonicalField[],
): FieldMapping => {
  const mapped = recipe.types.filter((t) => t.type !== "IGNORE");
  return {
    dateFormat: "iso",
    columns: Object.fromEntries(fields.map((field) => [field, field])),
    typeMap: Object.fromEntries(mapped.map((t) => [t.label.toLowerCase(), t.type])),
    ignoredTypes: Object.fromEntries(
      recipe.types
        .filter((t) => t.type === "IGNORE")
        .map((t) => [t.label.toLowerCase(), t.reason ?? "Ohitettu"]),
    ),
    amountSign: recipe.unsignedAmount
      ? Object.fromEntries(mapped.map((t) => [t.label.toLowerCase(), t.sign ?? 1]))
      : undefined,
  };
};

/** One field's printed text as the plain value `mapRows` parses. */
export const readField = (
  field: CanonicalField,
  text: string,
  format: Pick<BrokerTable, "dateFormat" | "money">,
): string => {
  const raw = text.trim();
  if (raw === "") return "";
  if (field === "tradeDate") return readDate(raw, format.dateFormat);
  return NUMERIC.has(field) ? readDecimal(raw, format.money) : raw;
};

/** One row's cells, read by the recipe into the plain text `mapRows` parses. */
const normalise = (row: RawRow, recipe: BrokerTable): RawRow => {
  const values: Record<string, string> = {};
  for (const column of recipe.columns) {
    const raw =
      column.position === null
        ? (row.values[column.header] ?? "")
        : (row.cells[column.position - 1] ?? "");
    values[column.field] = readField(column.field, raw, recipe);
  }
  return { line: row.line, values, cells: [] };
};

/**
 * Normalised rows into a draft, and which of its problems are failures: every
 * problem except a row the recipe deliberately ignored, which is reported on
 * review but means the recipe did its job.
 */
export const mapNormalised = (
  rows: readonly RawRow[],
  csvProblems: readonly CsvProblem[],
  mapping: FieldMapping,
  known: KnownInstruments,
  accountId: number,
) => {
  const mapped = mapRows(rows, mapping, known.knownIsins, {
    accountId,
    csvProblems: [...csvProblems],
    knownNames: known.knownNames,
  });
  // A broker that prints no ISIN (OP's web view) still names an instrument the
  // ledger knows; its row shows that instrument's ISIN rather than a blank.
  const isinOf = new Map([...known.knownIsins].map(([isin, id]) => [id, isin] as const));
  const draft = {
    ...mapped,
    txns: mapped.txns.map((txn) =>
      txn.isin === null && txn.instrumentId !== null
        ? { ...txn, isin: isinOf.get(txn.instrumentId) ?? null }
        : txn,
    ),
  };
  const ignored = new Set(Object.keys(mapping.ignoredTypes ?? {}));
  const ignoredLines = new Set(
    rows.filter((row) => ignored.has((row.values.type ?? "").toLowerCase())).map((r) => r.line),
  );
  const failures = draft.problems
    .filter((problem) => !ignoredLines.has(problem.line))
    .map(({ line, message }) => ({ line, message }));
  return { draft, failures };
};

export type TableRun = {
  readonly draft: Draft;
  /** Rows as `mapRows` read them, for checks that look across rows. */
  readonly rows: readonly RawRow[];
  readonly missingHeaders: readonly string[];
  /** Problems that are not a deliberately ignored type. */
  readonly failures: readonly { readonly line: number; readonly message: string }[];
};

export type KnownInstruments = {
  readonly knownIsins: ReadonlyMap<string, number>;
  readonly knownNames: ReadonlyMap<string, number>;
};

export const runBrokerTable = (
  bytes: ArrayBuffer,
  recipe: BrokerTable,
  known: KnownInstruments,
  accountId: number,
): TableRun => {
  const parsed = parseCsv(bytes, { encoding: encodingOf(bytes), delimiter: recipe.delimiter });
  const present = new Set(parsed.headers);
  const missingHeaders = recipe.columns
    .filter((c) =>
      c.position === null ? !present.has(c.header) : parsed.headers[c.position - 1] !== c.header,
    )
    .map((c) => c.header);

  const rows: RawRow[] = [];
  const csvProblems: CsvProblem[] = [...parsed.problems];
  if (missingHeaders.length === 0) {
    for (const row of parsed.rows) {
      try {
        rows.push(normalise(row, recipe));
      } catch (cause) {
        csvProblems.push({
          line: row.line,
          message: cause instanceof Error ? cause.message : "Rivin käsittely epäonnistui",
          raw: row.cells.join(recipe.delimiter),
        });
      }
    }
  }
  const { draft, failures } = mapNormalised(
    rows,
    csvProblems,
    mappingOf(
      recipe,
      recipe.columns.map((column) => column.field),
    ),
    known,
    accountId,
  );
  return { draft, rows, missingHeaders, failures };
};

/**
 * How a label becomes a transaction type, shared by every broker recipe. The
 * hard cases are corporate actions: legs that move no cash, where ignoring
 * both halves of a pair silently strands units on a line that no longer
 * exists -- which is what a model told "ignore when unsure" did to a real
 * reverse split.
 */
export const TYPE_RULES = [
  "types: jokainen esiintyvä laji (label täsmälleen kuten kirjoitettu) ja sen tyyppi.",
  "IGNORE vain kun samat kappaleet tai sama raha ovat jo toisella rivillä, ja kerro silloin reason. Älä koskaan ohita parin molempia puolia, jos kappaleita siirtyy tai määrä muuttuu.",
  "Kun osakkeet siirtyvät arvopaperilajista toiseen (esim. YHDISTELY - OTTO ja YHDISTELY - JÄTTÖ): OTTO on TRANSFER_OUT ja JÄTTÖ on TRANSFER_IN.",
  "Kun saman arvopaperin kappalemäärä muuttuu ilman rahaa (käänteinen split tai osakkeiden vaihto, esim. VAIHTO - OTTO ja VAIHTO - JÄTTÖ): JÄTTÖ on SPLIT ja sen quantity on uusi kokonaismäärä; OTTO on IGNORE.",
  "Merkintä rahalla (esim. MERKINTÄ) on BUY. Merkintäoikeudet jotka eivät jää salkkuun (esim. IRROTUS - JÄTTÖ ja MERKINTÄOIK. OTTO): molemmat IGNORE.",
  "Jos laji on aidosti tuntematon, käytä IGNORE ja kerro reason-kentässä miksi.",
].join("\n");

const INSTRUCTIONS = [
  "Saat välittäjän tapahtumaluettelon alun (CSV tai verkkopalvelusta kopioitu taulukko) ja jokaisen sarakkeen kaikki erilaiset arvot, kun niitä on vähän. Kuvaa sen muoto JSON-oliona, jolla ohjelma lukee jokaisen rivin.",
  "delimiter: sarake-erotin. columns: mikä otsikkorivin sarake (täsmälleen kuten kirjoitettu) on mikin kenttä. Pakolliset: tradeDate, type, amount. position vain jos sama otsikko toistuu, muuten null.",
  "Kentät: tradeDate kauppapäivä, type tapahtuman laji, instrumentName arvopaperin nimi, isin, quantity kappalemäärä, unitPrice kurssi, fee kulut, currency summan valuutta, amount rahavirta, costBasis siirtyvä hankinta-arvo (vaihdoissa), note välittäjän selite, priceCurrency kurssin valuutta, portfolio välittäjän tilinumero, externalId tapahtuman tunniste.",
  TYPE_RULES,
  "unsignedAmount: true jos osto ja myynti tulostuvat samanmerkkisinä; silloin sign kertoo rahan suunnan (osto -1, myynti 1).",
  "money kertoo desimaali- ja tuhaterottimen, negatiivisen merkinnän ja strip-listassa yksiköt jotka poistetaan (esim. kpl, EUR).",
].join("\n");

/** Every column's distinct values, for the columns with few of them: the labels. */
const labelsOf = (bytes: ArrayBuffer): string => {
  const lines = linesOf(bytes);
  const header = lines[0] ?? "";
  const delimiter = ["\t", ";", ",", "|"].reduce((best, candidate) =>
    header.split(candidate).length > header.split(best).length ? candidate : best,
  );
  const parsed = parseCsv(bytes, { encoding: encodingOf(bytes), delimiter });
  return parsed.headers
    .map((name, index) => {
      const distinct = new Set(parsed.rows.map((row) => (row.cells[index] ?? "").trim()));
      distinct.delete("");
      const hasText = [...distinct].some((value) => /\p{L}/u.test(value));
      return distinct.size > 0 && distinct.size <= MAX_LABELS && hasText
        ? `${name}: ${[...distinct].join(" | ")}`
        : null;
    })
    .filter((line): line is string => line !== null)
    .join("\n");
};

export const passes = (run: TableRun): boolean =>
  run.missingHeaders.length === 0 && run.failures.length === 0 && run.draft.txns.length > 0;

export const feedbackOf = (run: TableRun): string => {
  if (run.missingHeaders.length > 0) {
    return `Näitä sarakkeita ei ole otsikkorivillä: ${run.missingHeaders.join(", ")}`;
  }
  if (run.failures.length === 0) return "Yhtään tapahtumaa ei luettu.";
  return run.failures
    .slice(0, QUOTED_FAILURES)
    .map((failure) => `rivi ${failure.line}: ${failure.message}`)
    .join("\n");
};

export const brokerTableKey = (bytes: ArrayBuffer): string =>
  fingerprint("broker-table", linesOf(bytes).slice(0, 1));

/**
 * A broker's transaction table -- an uploaded CSV or a pasted one. A stored
 * recipe for this header is tried first; one that no longer reads every row is
 * forgotten and described again. Only a recipe that read every row is stored.
 */
export const readBrokerTableByRecipe = async (
  bytes: ArrayBuffer,
  userId: string,
  client: ChatClient,
  known: KnownInstruments,
  accountId: number,
): Promise<TableRun> => {
  const key = brokerTableKey(bytes);
  const run = (recipe: BrokerTable) => runBrokerTable(bytes, recipe, known, accountId);
  const stored = await loadParsed(userId, key, parseBrokerTable);
  if (stored !== null) {
    const result = run(stored);
    if (passes(result)) return result;
    await forgetRecipe(userId, key);
  }
  const asked = await askForRecipe({
    client,
    instructions: INSTRUCTIONS,
    sample: `${linesOf(bytes)
      .slice(0, SAMPLE_ROWS + 1)
      .join("\n")}\n\nSarakkeiden arvot:\n${labelsOf(bytes)}`,
    schema: BrokerTableSchema,
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
