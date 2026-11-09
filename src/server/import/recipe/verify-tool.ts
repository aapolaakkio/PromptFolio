import { z } from "zod";

import type { ToolCall, ToolDefinition } from "../../chat/runner.ts";
import type { BankRow } from "../bank-statement.ts";
import { runRecipe, type RecipeRun } from "./run.ts";
import { BankRecipeSchema, parseRecipe, type BankRecipe } from "./types.ts";
import { eur, looksLikeTransaction, unclaimedWorthReporting, verifyRun } from "./verify.ts";

export const VERIFY_TOOL_NAME = "verify_recipe";

const MAX_LISTED = 10;
const MAX_SAMPLE_ROWS = 3;

const UNREADABLE_RUN = "The recipe could not be run on the file";

type Line = { readonly line: number; readonly text: string };
type SampleRow = {
  readonly date: string;
  readonly amount: string;
  readonly counterparty: string;
  readonly message: string;
  readonly externalId: string | null;
};

type VerifyResult = {
  readonly ok: boolean;
  readonly error?: string;
  readonly report?: string;
  readonly unclaimed: readonly Line[];
  readonly skippedLookingLikeTransactions: readonly Line[];
  readonly balance: {
    readonly opening: string;
    readonly rows: string;
    readonly closing: string;
    readonly delta: string;
  } | null;
  readonly rowCount: number;
  readonly problems: readonly { readonly line: number; readonly message: string }[];
  readonly sampleRows: readonly SampleRow[];
};

type Attempt = { readonly recipe: BankRecipe; readonly run: RecipeRun };

const VerifyArgs = z.object({ recipe: z.looseObject({}) });
type VerifyInput = z.infer<typeof VerifyArgs>;

type RecipeTool = {
  readonly name: string;
  readonly description: string;
  readonly schema: typeof VerifyArgs;
  readonly run: (input: VerifyInput) => Promise<VerifyResult>;
};

const DESCRIPTION =
  "Runs the recipe you propose over the whole bank statement and reports what went wrong: " +
  "unrecognised lines, skipped lines that look like transactions, the balance check and " +
  "the first three extracted transactions. Call this with every proposal. " +
  "When the result is ok, the work is done.";

export const verifyToolDefinition: ToolDefinition = {
  name: VERIFY_TOOL_NAME,
  description: DESCRIPTION,
  input_schema: {
    type: "object",
    properties: {
      recipe: z.toJSONSchema(BankRecipeSchema, { io: "input", unrepresentable: "any" }),
    },
    required: ["recipe"],
    additionalProperties: false,
  },
};

const messageOf = (row: BankRow): string => {
  if (row.counterparty === "") return row.note;
  const at = row.note.indexOf(row.counterparty);
  return at < 0 ? row.note : row.note.slice(at + row.counterparty.length).trim();
};

const sampleRowsOf = (rows: readonly BankRow[]): SampleRow[] =>
  rows.slice(0, MAX_SAMPLE_ROWS).map((row) => ({
    date: row.date,
    amount: eur(row.amount),
    counterparty: row.counterparty,
    message: messageOf(row),
    externalId: row.externalId,
  }));

const listed = (entries: readonly Line[]): Line[] =>
  entries.slice(0, MAX_LISTED).map((entry) => ({ line: entry.line, text: entry.text }));

const failed = (error: string): VerifyResult => ({
  ok: false,
  error,
  unclaimed: [],
  skippedLookingLikeTransactions: [],
  balance: null,
  rowCount: 0,
  problems: [],
  sampleRows: [],
});

const describe = (run: RecipeRun, report: string | null): VerifyResult => {
  const { statement } = run;
  const movement = statement.rows.reduce((sum, row) => sum + row.amount, 0n);
  const base = {
    ok: report === null,
    unclaimed: listed(unclaimedWorthReporting(run)),
    skippedLookingLikeTransactions: listed(run.skipped.filter(looksLikeTransaction)),
    balance: {
      opening: eur(statement.openingBalance.minor),
      rows: eur(movement),
      closing: eur(statement.closingBalance.minor),
      delta: eur(statement.closingBalance.minor - statement.openingBalance.minor - movement),
    },
    rowCount: statement.rows.length,
    problems: statement.problems.slice(0, MAX_LISTED).map((problem) => ({ ...problem })),
    sampleRows: sampleRowsOf(statement.rows),
  };
  return report === null ? base : { ...base, report };
};

const better = (candidate: Attempt, incumbent: Attempt | null): boolean => {
  if (incumbent === null) return true;
  const rows = candidate.run.statement.rows.length;
  const previous = incumbent.run.statement.rows.length;
  if (rows !== previous) return rows > previous;
  return candidate.run.statement.problems.length < incumbent.run.statement.problems.length;
};

type VerifySession = {
  readonly tool: RecipeTool;
  readonly verified: () => Attempt | null;
  readonly best: () => Attempt | null;
  readonly lastError: () => string | null;
};

/** A recipe counts as verified only because it was run and checked here. Nothing thrown escapes. */
export const createVerifySession = (text: string): VerifySession => {
  let verified: Attempt | null = null;
  let best: Attempt | null = null;
  let lastError: string | null = null;

  const check = async (input: VerifyInput): Promise<VerifyResult> => {
    let recipe: BankRecipe;
    try {
      recipe = parseRecipe(input.recipe);
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : UNREADABLE_RUN;
      return failed(lastError);
    }
    try {
      const run = runRecipe(text, recipe);
      const verdict = verifyRun(run);
      const attempt = { recipe, run };
      if (better(attempt, best)) best = attempt;
      if (verdict.ok) verified = attempt;
      return describe(run, verdict.ok ? null : verdict.report);
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : UNREADABLE_RUN;
      return failed(lastError);
    }
  };

  return {
    tool: {
      name: VERIFY_TOOL_NAME,
      description: DESCRIPTION,
      schema: VerifyArgs,
      run: check,
    },
    verified: () => verified,
    best: () => best,
    lastError: () => lastError,
  };
};

export const runVerifyCall = async (session: VerifySession, call: ToolCall): Promise<string> => {
  if (call.name !== VERIFY_TOOL_NAME) {
    return JSON.stringify(failed(`Unknown tool: ${call.name}`));
  }
  let raw: unknown;
  try {
    raw = JSON.parse(call.arguments.trim() === "" ? "{}" : call.arguments);
  } catch {
    return JSON.stringify(failed("The tool arguments are not JSON"));
  }
  const parsed = session.tool.schema.safeParse(raw);
  if (!parsed.success) {
    return JSON.stringify(failed(`Give the recipe in the recipe field: ${parsed.error.message}`));
  }
  return JSON.stringify(await session.tool.run(parsed.data));
};
