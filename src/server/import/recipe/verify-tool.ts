import { z } from "zod";

import { EUR, formatMoney, money } from "../../../core/money.ts";
import type { ToolCall, ToolDefinition } from "../../chat/runner.ts";
import type { BankRow } from "../bank-statement.ts";
import { runRecipe, type RecipeRun } from "./run.ts";
import { BankRecipeSchema, parseRecipe, type BankRecipe } from "./types.ts";
import { looksLikeTransaction, unclaimedWorthReporting, verifyRun } from "./verify.ts";

export const VERIFY_TOOL_NAME = "verify_recipe";

/** Enough lines for the model to see the pattern, few enough to stay a prompt. */
const MAX_LISTED = 10;
/**
 * Rows handed back so the model can see a field landing in the wrong column --
 * an empty counterparty on every row, a message captured as a payee. They come
 * from page one, which is already in the model's sample, so nothing new leaves.
 */
const MAX_SAMPLE_ROWS = 3;

const UNREADABLE_RUN = "Kuvausta ei voitu ajaa tiedostolle";

const eur = (minor: bigint): string => formatMoney(money(minor, EUR));

type Line = { readonly line: number; readonly text: string };
type SampleRow = {
  readonly date: string;
  readonly amount: string;
  readonly counterparty: string;
  readonly message: string;
  readonly externalId: string | null;
};

export type VerifyResult = {
  readonly ok: boolean;
  /** Set when the candidate could not be run at all: bad schema, bad pattern, no balances. */
  readonly error?: string;
  /** What verification complained about, in the words the owner would see. */
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

/** One candidate that ran, with the reading it produced. */
export type Attempt = { readonly recipe: BankRecipe; readonly run: RecipeRun };

const VerifyArgs = z.object({ recipe: z.looseObject({}) });
type VerifyInput = z.infer<typeof VerifyArgs>;

/**
 * A tool as the chat runner defines one: a name, a description, the schema of
 * what it takes, and a handler that answers in JSON. Its own type because its
 * argument is a recipe rather than a ledger query.
 */
export type RecipeTool = {
  readonly name: string;
  readonly description: string;
  readonly schema: typeof VerifyArgs;
  readonly run: (input: VerifyInput) => Promise<VerifyResult>;
};

const DESCRIPTION =
  "Ajaa ehdottamasi kuvauksen koko tiliotteelle ja kertoo mikä meni pieleen: " +
  "tunnistamattomat rivit, ohitetut tapahtumannäköiset rivit, saldotarkistus ja " +
  "kolme ensimmäistä poimittua tapahtumaa. Kutsu tätä jokaisella ehdotuksellasi. " +
  "Kun tulos on ok, työ on valmis.";

/**
 * What the model is shown: the recipe schema itself, so the field names and the
 * allowed values come from the same definition that will judge the answer.
 */
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

/**
 * The message half of a row's note. `runRecipe` joins label, counterparty and
 * message into one note, so the message is what follows the counterparty in it.
 */
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

/**
 * What the model reads after one attempt. The balances are included even when
 * the reading passes: seeing them add up is what makes the pass believable.
 */
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

/** More rows read wins; between equals, the reading with fewer problems. */
const better = (candidate: Attempt, incumbent: Attempt | null): boolean => {
  if (incumbent === null) return true;
  const rows = candidate.run.statement.rows.length;
  const previous = incumbent.run.statement.rows.length;
  if (rows !== previous) return rows > previous;
  return candidate.run.statement.problems.length < incumbent.run.statement.problems.length;
};

export type VerifySession = {
  readonly tool: RecipeTool;
  /** The last candidate that passed verification, or null. */
  readonly verified: () => Attempt | null;
  /** The most complete reading seen, verified or not: the fallback draft. */
  readonly best: () => Attempt | null;
  /** Why the last candidate could not be run at all, when none ever ran. */
  readonly lastError: () => string | null;
};

/**
 * The `verify_recipe` tool bound to one document, and the memory of what it
 * has seen. The handler is the source of truth: a recipe counts as verified
 * because it was run and checked here, never because the model said so.
 *
 * Nothing thrown escapes it. A schema-invalid recipe, a pattern the safety
 * check refuses, a statement whose balances the recipe cannot find -- each is
 * an ordinary result the model can read and fix, because a throw would end the
 * turn at the exact moment there is something to learn.
 */
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

/**
 * One tool call from the model, answered as the JSON string that goes back into
 * the conversation. A name the model invented and arguments that are not the
 * shape the tool takes are answered rather than thrown, for the same reason.
 */
export const runVerifyCall = async (session: VerifySession, call: ToolCall): Promise<string> => {
  if (call.name !== VERIFY_TOOL_NAME) {
    return JSON.stringify(failed(`Tuntematon työkalu: ${call.name}`));
  }
  let raw: unknown;
  try {
    raw = JSON.parse(call.arguments.trim() === "" ? "{}" : call.arguments);
  } catch {
    return JSON.stringify(failed("Työkalun argumentit eivät ole JSONia"));
  }
  const parsed = session.tool.schema.safeParse(raw);
  if (!parsed.success) {
    return JSON.stringify(failed(`Anna kuvaus recipe-kentässä: ${parsed.error.message}`));
  }
  return JSON.stringify(await session.tool.run(parsed.data));
};
