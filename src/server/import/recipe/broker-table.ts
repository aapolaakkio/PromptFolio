import { z } from "zod";

import type { ChatClient } from "../../chat/runner.ts";
import { parseCsv } from "../csv.ts";
import { type Draft, mapRows } from "../map.ts";
import type { CanonicalField, CsvProblem, FieldMapping, RawRow } from "../types.ts";
import { askForRecipe, FINNISH_CONTEXT } from "./ask.ts";
import { encodingOf, linesOf } from "./csv-recipe.ts";
import { readDate } from "./date-format.ts";
import { fingerprint } from "./fingerprint.ts";
import { readDecimal } from "./money-format.ts";
import { forgetRecipe, loadParsed, saveRecipe } from "./store.ts";
import { MoneyFormatSchema } from "./types.ts";

const SAMPLE_ROWS = 30;
const MAX_LABELS = 40;
const QUOTED_FAILURES = 10;
const NOT_READABLE = "The file was not recognised as a transaction list";

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

const NUMERIC: ReadonlySet<CanonicalField> = new Set([
  "quantity",
  "unitPrice",
  "fee",
  "amount",
  "costBasis",
]);

const TYPES = [
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
            position: z.number().int().min(1).nullable(),
          })
          .strict(),
      )
      .max(FIELDS.length),
    dateFormat: z.enum(["d.m.yyyy", "dd.mm.yyyy", "m.d.yyyy", "yyyy-mm-dd"]),
    money: MoneyFormatSchema,
    unsignedAmount: z.boolean(),
    types: z.array(TypeRuleSchema).max(80),
  })
  .strict();

export const BrokerTableSchema = BaseBrokerTable.superRefine((recipe, ctx) => {
  const fields = recipe.columns.map((column) => column.field);
  for (const required of ["tradeDate", "type", "amount"] as const) {
    if (!fields.includes(required)) {
      ctx.addIssue({ code: "custom", message: `Missing column: ${required}` });
    }
  }
  if (new Set(fields).size !== fields.length) {
    ctx.addIssue({ code: "custom", message: "The same field is named twice" });
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

export type BrokerTable = z.infer<typeof BaseBrokerTable>;

// eslint-disable-next-line anti-slop/no-unknown-parameters
const parseBrokerTable = (raw: unknown): BrokerTable => BrokerTableSchema.parse(raw);

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
        .map((t) => [t.label.toLowerCase(), t.reason ?? "Ignored"]),
    ),
    amountSign: recipe.unsignedAmount
      ? Object.fromEntries(mapped.map((t) => [t.label.toLowerCase(), t.sign ?? 1]))
      : undefined,
  };
};

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
  // A broker that prints no ISIN (OP's web view) still names a known instrument: show its ISIN.
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
  readonly rows: readonly RawRow[];
  readonly missingHeaders: readonly string[];
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
          message: cause instanceof Error ? cause.message : "Failed to process the row",
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

/** Ignoring both halves of a corporate-action pair strands units (a model did this to a real reverse split). OTTO takes units out, JÄTTÖ puts them in. */
export const TYPE_RULES = [
  "types: every type label that occurs (label exactly as written) and its type.",
  "IGNORE only when the same units or the same money are already on another row, and then give a reason. Never ignore both halves of a pair if units move or the quantity changes.",
  "When shares move from one security type to another (e.g. YHDISTELY - OTTO and YHDISTELY - JÄTTÖ, a consolidation): OTTO is TRANSFER_OUT and JÄTTÖ is TRANSFER_IN.",
  "An exchange pair (e.g. VAIHTO AP-OTTO and VAIHTO AP-JÄTTÖ, or VAIHTO - OTTO and VAIHTO - JÄTTÖ) can swap one security for another (a name or ISIN change, a merger) and not only change the quantity. If the file has a column for the transferred cost basis (costBasis), OTTO is TRANSFER_OUT and JÄTTÖ is TRANSFER_IN.",
  "If there is no cost basis column: JÄTTÖ is SPLIT and its quantity is the new total quantity, and OTTO is IGNORE.",
  "A subscription paid in cash (e.g. MERKINTÄ) is BUY. Subscription rights that do not stay in the portfolio (e.g. IRROTUS - JÄTTÖ and MERKINTÄOIK. OTTO): both IGNORE.",
  "If a type is genuinely unknown, use IGNORE and say why in the reason field.",
].join("\n");

const INSTRUCTIONS = [
  FINNISH_CONTEXT,
  "You receive the start of a broker's transaction list (a CSV or a table copied from a web service) and, for each column, all of its distinct values when there are few. Describe its format as a JSON object that the program uses to read every row.",
  "delimiter: the column delimiter. columns: which header-row column (exactly as written) is which field. Required: tradeDate, type, amount. position only if the same header repeats, otherwise null.",
  "Fields: tradeDate trade date, type transaction type, instrumentName name of the instrument, isin, quantity number of units, unitPrice price per unit, fee fees, currency currency of the amount, amount cash flow, costBasis transferred cost basis (in exchanges), note the broker's description, priceCurrency currency of the price, portfolio the broker's account number, externalId transaction identifier.",
  TYPE_RULES,
  "unsignedAmount: true if buys and sells print with the same sign; then sign gives the direction of the money (buy -1, sell 1).",
  "money gives the decimal and thousands separators, the negative notation, and in the strip list the units to remove (e.g. kpl, EUR).",
].join("\n");

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
    return `These columns are not in the header row: ${run.missingHeaders.join(", ")}`;
  }
  if (run.failures.length === 0) return "No transactions were read.";
  return run.failures
    .slice(0, QUOTED_FAILURES)
    .map((failure) => `line ${failure.line}: ${failure.message}`)
    .join("\n");
};

const brokerTableKey = (bytes: ArrayBuffer): string =>
  fingerprint("broker-table", linesOf(bytes).slice(0, 1));

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
      .join("\n")}\n\nColumn values:\n${labelsOf(bytes)}`,
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
