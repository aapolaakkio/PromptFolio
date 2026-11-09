import { EUR, money, type Money } from "../../../core/money.ts";
import type { PdfStatement } from "../bank-pdf.ts";
import { rowType, type BankRow } from "../bank-statement.ts";
import { readDate } from "./date-format.ts";
import { readAmount, readTwoColumn } from "./money-format.ts";
import type { BankRecipe } from "./types.ts";

export type Unclaimed = { readonly line: number; readonly text: string };
export type Skipped = { readonly line: number; readonly text: string };
export type RecipeRun = {
  readonly statement: PdfStatement;
  /** The only check that sees one wrong amount: an error and its mirror image add up. */
  readonly rowBalances: readonly (bigint | null)[];
  readonly unclaimed: readonly Unclaimed[];
  /** A skipped line with a date and an amount is discarded money; coverage cannot see it. */
  readonly skipped: readonly Skipped[];
};

/** The time budget ran out. Kept distinct: a stored recipe that trips it trips it on every import. */
export class RecipeTimeoutError extends Error {
  constructor() {
    super("Reading the statement took too long");
    this.name = "RecipeTimeoutError";
  }
}

const TIME_BUDGET_MS = 5_000;
const CHECK_EVERY = 200;

const makeBudgetChecker = (budgetMs: number): (() => void) => {
  const started = Date.now();
  let ticks = 0;
  return () => {
    ticks += 1;
    if (ticks % CHECK_EVERY === 1 && Date.now() - started > budgetMs) {
      throw new RecipeTimeoutError();
    }
  };
};

/** `m` so `^`/`$` in a continuation or header-fallback pattern anchor to a line of the joined text. */
const compile = (source: string): RegExp => new RegExp(source, "um");
const compileAll = (sources: readonly string[]): RegExp[] => sources.map(compile);

const groupValue = (match: RegExpExecArray): string | null =>
  match.groups?.value ?? match[1] ?? null;

const linesCovered = (lines: readonly string[], start: number, end: number): Set<number> => {
  const covered = new Set<number>();
  let at = 0;
  for (const [index, line] of lines.entries()) {
    const lineEnd = at + line.length;
    if (start < lineEnd && end > at) covered.add(index);
    at = lineEnd + 1;
  }
  return covered;
};

const firstAndLast = (indexes: ReadonlySet<number>): Set<number> => {
  if (indexes.size === 0) return new Set();
  const sorted = [...indexes].sort((a, b) => a - b);
  return new Set([sorted[0]!, sorted.at(-1)!]);
};

/** First match for an opening fact, last for a closing one; a fallback match claims only its first and last line. */
const readHeaderField = (
  lines: readonly string[],
  source: string | undefined,
  last: boolean,
  checkBudget: () => void,
) => {
  const noFallback = new Set<number>();
  if (source === undefined) return { value: null, claimedByFallback: noFallback };
  const pattern = compile(source);
  const perLine = lines.flatMap((line) => {
    checkBudget();
    const match = pattern.exec(line);
    return match ? [groupValue(match)] : [];
  });
  if (perLine.length > 0) {
    return { value: (last ? perLine.at(-1) : perLine[0]) ?? null, claimedByFallback: noFallback };
  }
  checkBudget();
  const whole = pattern.exec(lines.join("\n"));
  if (!whole) return { value: null, claimedByFallback: noFallback };
  const covered = linesCovered(lines, whole.index, whole.index + whole[0].length);
  return { value: groupValue(whole), claimedByFallback: firstAndLast(covered) };
};

type HeaderFacts = {
  readonly from: string | null;
  readonly to: string | null;
  readonly openingBalance: string | null;
  readonly closingBalance: string | null;
  readonly maturityDate: string | null;
  readonly claimedLines: ReadonlySet<number>;
};

/** Record-start lines are blanked: a broad pattern must not read a fact off a transaction. */
const resolveHeaderFacts = (
  lines: readonly string[],
  header: BankRecipe["header"],
  checkBudget: () => void,
): HeaderFacts => {
  const claimedLines = new Set<number>();
  const read = (source: string | undefined, last: boolean): string | null => {
    const { value, claimedByFallback } = readHeaderField(lines, source, last, checkBudget);
    for (const index of claimedByFallback) claimedLines.add(index);
    return value;
  };
  return {
    from: read(header.from, false),
    to: read(header.to, true),
    openingBalance: read(header.openingBalance, false),
    closingBalance: read(header.closingBalance, true),
    maturityDate: read(header.maturityDate, false),
    claimedLines,
  };
};

type StatementHeader = {
  readonly from: string;
  readonly to: string;
  readonly yearHint: string;
  readonly maturityDate: string | null;
  readonly openingBalance: Money;
  readonly closingBalance: Money;
};

const REQUIRED_FACTS = [
  ["from", "period start"],
  ["to", "period end"],
  ["openingBalance", "opening balance"],
  ["closingBalance", "closing balance"],
] as const;

const buildStatementHeader = (facts: HeaderFacts, recipe: BankRecipe): StatementHeader => {
  const missing = REQUIRED_FACTS.filter(([key]) => facts[key] === null).map(([, name]) => name);
  if (missing.length > 0) {
    throw new Error(`Not found in the statement: ${missing.join(", ")}`);
  }
  // SAFETY: `missing` is empty, so every REQUIRED_FACTS entry read non-null.
  const from = readDate(facts.from!, recipe.dateFormat);
  const to = readDate(facts.to!, recipe.dateFormat);
  const yearHint = to.slice(0, 4);
  const maturityDate =
    facts.maturityDate === null ? null : readDate(facts.maturityDate, recipe.dateFormat, yearHint);
  return {
    from,
    to,
    yearHint,
    maturityDate,
    openingBalance: money(readAmount(facts.openingBalance!, recipe.money), EUR),
    closingBalance: money(readAmount(facts.closingBalance!, recipe.money), EUR),
  };
};

const findRecordStarts = (
  lines: readonly string[],
  recordStart: RegExp,
  skip: readonly RegExp[],
  checkBudget: () => void,
): number[] =>
  lines.flatMap((line, index) => {
    checkBudget();
    const opens = recordStart.test(line) && !skip.some((pattern) => pattern.test(line));
    return opens ? [index] : [];
  });

/** A header pattern may not claim a record-start line, or an over-broad one would take transactions out of coverage. */
const buildClaimed = (
  lines: readonly string[],
  starts: readonly number[],
  skip: readonly RegExp[],
  headerPatterns: readonly RegExp[],
  headerFallbackClaims: ReadonlySet<number>,
  checkBudget: () => void,
): Set<number> => {
  const startLines = new Set(starts);
  const claimed = new Set<number>([
    ...starts,
    ...[...headerFallbackClaims].filter((index) => !startLines.has(index)),
  ]);
  for (const [index, line] of lines.entries()) {
    checkBudget();
    const isHeaderLine = !startLines.has(index) && headerPatterns.some((p) => p.test(line));
    if (line === "" || isHeaderLine || skip.some((pattern) => pattern.test(line))) {
      claimed.add(index);
    }
  }
  return claimed;
};

const findSkipped = (
  lines: readonly string[],
  skip: readonly RegExp[],
  headerPatterns: readonly RegExp[],
  headerFallbackClaims: ReadonlySet<number>,
  checkBudget: () => void,
): Skipped[] =>
  lines.flatMap((line, index) => {
    checkBudget();
    if (line === "" || !skip.some((pattern) => pattern.test(line))) return [];
    if (headerFallbackClaims.has(index)) return [];
    if (headerPatterns.some((pattern) => pattern.test(line))) return [];
    return [{ line: index + 1, text: line }];
  });

type BlockFields = {
  readonly fields: Readonly<Record<string, string>>;
  readonly consumedLocal: ReadonlySet<number>;
};

/** recordStart groups win, continuation patterns fill the rest, restField takes the first unclaimed line. */
const readBlockFields = (
  block: readonly string[],
  continuation: readonly RegExp[],
  restField: BankRecipe["restField"],
  groups: Readonly<Record<string, string | undefined>>,
  checkBudget: () => void,
): BlockFields => {
  const joined = block.join("\n");
  const fields: Record<string, string> = {};
  const consumedLocal = new Set<number>();
  for (const pattern of continuation) {
    checkBudget();
    const match = pattern.exec(joined);
    if (!match) continue;
    for (const [name, value] of Object.entries(match.groups ?? {})) {
      if (value !== undefined && fields[name] === undefined) fields[name] = value;
    }
    for (const covered of linesCovered(block, match.index, match.index + match[0].length)) {
      consumedLocal.add(covered);
    }
  }
  const remaining = block.flatMap((value, at) => (consumedLocal.has(at) ? [] : [{ value, at }]));
  const rest = remaining[0];
  const restAlreadySet =
    restField !== null && (groups[restField] !== undefined || fields[restField] !== undefined);
  if (restField !== null && rest !== undefined && !restAlreadySet) {
    fields[restField] = rest.value;
    consumedLocal.add(rest.at);
  }
  return { fields, consumedLocal };
};

const readBalance = (text: string | undefined, recipe: BankRecipe): bigint | null => {
  if (text === undefined) return null;
  try {
    return readAmount(text, recipe.money);
  } catch {
    return null;
  }
};

const buildRowOutcome = (
  groups: Readonly<Record<string, string | undefined>>,
  fields: Readonly<Record<string, string>>,
  recipe: BankRecipe,
  start: number,
  yearHint: string,
) => {
  const field = (name: string): string | undefined => groups[name] ?? fields[name];

  try {
    const amount = recipe.money.twoColumn
      ? readTwoColumn(field("debit") ?? "", field("credit") ?? "", recipe.money)
      : readAmount(field("amount") ?? "", recipe.money);
    const counterparty = field("counterparty") ?? "";
    const note = [field("label") ?? "", counterparty, field("message") ?? ""]
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .join(" — ");
    const row: BankRow = {
      line: start + 1,
      date: readDate(field("date") ?? "", recipe.dateFormat, yearHint),
      type: rowType(note, amount, ["KORKO"]), // "korko" is Finnish for interest
      amount,
      counterparty,
      note,
      externalId: field("externalId") ?? null,
    };
    return { row, problem: null, balance: readBalance(field("balance"), recipe) };
  } catch (cause) {
    return {
      row: null,
      balance: null,
      problem: {
        line: start + 1,
        message: cause instanceof Error ? cause.message : "Failed to process the row",
      },
    };
  }
};

type BlockOutcome = {
  readonly row: BankRow | null;
  readonly problem: { readonly line: number; readonly message: string } | null;
  readonly balance: bigint | null;
  readonly consumedIndexes: ReadonlySet<number>;
};

const processRecordBlock = (
  lines: readonly string[],
  start: number,
  end: number,
  claimed: ReadonlySet<number>,
  recordStart: RegExp,
  continuation: readonly RegExp[],
  recipe: BankRecipe,
  yearHint: string,
  checkBudget: () => void,
): BlockOutcome => {
  const blockIndexes = Array.from(
    { length: end - start - 1 },
    (_, offset) => start + 1 + offset,
  ).filter((index) => !claimed.has(index));
  const block = blockIndexes.map((index) => lines[index] ?? "");

  const head = recordStart.exec(lines[start] ?? "");
  const groups = { ...head?.groups };
  const { fields, consumedLocal } = readBlockFields(
    block,
    continuation,
    recipe.restField,
    groups,
    checkBudget,
  );
  const consumedIndexes = new Set(
    [...consumedLocal].flatMap((at) => {
      const index = blockIndexes[at];
      return index === undefined ? [] : [index];
    }),
  );

  return { ...buildRowOutcome(groups, fields, recipe, start, yearHint), consumedIndexes };
};

type RecordsResult = {
  readonly rows: readonly BankRow[];
  readonly rowBalances: readonly (bigint | null)[];
  readonly problems: readonly { readonly line: number; readonly message: string }[];
  readonly consumed: ReadonlySet<number>;
};

const readRecords = (
  lines: readonly string[],
  starts: readonly number[],
  claimed: ReadonlySet<number>,
  recordStart: RegExp,
  continuation: readonly RegExp[],
  recipe: BankRecipe,
  yearHint: string,
  checkBudget: () => void,
): RecordsResult => {
  const rows: BankRow[] = [];
  const rowBalances: Array<bigint | null> = [];
  const problems: Array<{ line: number; message: string }> = [];
  const consumed = new Set<number>();
  for (const [order, start] of starts.entries()) {
    const end = starts[order + 1] ?? lines.length;
    const outcome = processRecordBlock(
      lines,
      start,
      end,
      claimed,
      recordStart,
      continuation,
      recipe,
      yearHint,
      checkBudget,
    );
    if (outcome.row !== null) {
      rows.push(outcome.row);
      rowBalances.push(outcome.balance);
    }
    if (outcome.problem !== null) problems.push(outcome.problem);
    for (const index of outcome.consumedIndexes) consumed.add(index);
  }
  return { rows, rowBalances, problems, consumed };
};

const findUnclaimed = (
  lines: readonly string[],
  claimed: ReadonlySet<number>,
  consumed: ReadonlySet<number>,
): Unclaimed[] =>
  lines.flatMap((line, index) =>
    claimed.has(index) || consumed.has(index) ? [] : [{ line: index + 1, text: line }],
  );

export const runRecipe = (
  text: string,
  recipe: BankRecipe,
  budgetMs = TIME_BUDGET_MS,
): RecipeRun => {
  const checkBudget = makeBudgetChecker(budgetMs);
  const lines = text.split("\n").map((line) => line.trim());
  const skip = compileAll(recipe.skip);
  const recordStart = compile(recipe.recordStart);
  const continuation = compileAll(recipe.continuation);

  const starts = findRecordStarts(lines, recordStart, skip, checkBudget);
  const startLines = new Set(starts);
  const headerLines = lines.map((line, index) => (startLines.has(index) ? "" : line));
  const facts = resolveHeaderFacts(headerLines, recipe.header, checkBudget);
  const header = buildStatementHeader(facts, recipe);

  const headerPatterns = [
    recipe.header.from,
    recipe.header.to,
    recipe.header.openingBalance,
    recipe.header.closingBalance,
    recipe.header.maturityDate,
  ]
    .filter((source): source is string => source !== undefined)
    .map(compile);
  const claimed = buildClaimed(
    lines,
    starts,
    skip,
    headerPatterns,
    facts.claimedLines,
    checkBudget,
  );

  const { rows, rowBalances, problems, consumed } = readRecords(
    lines,
    starts,
    claimed,
    recordStart,
    continuation,
    recipe,
    header.yearHint,
    checkBudget,
  );
  const unclaimed = findUnclaimed(lines, claimed, consumed);
  const skipped = findSkipped(lines, skip, headerPatterns, facts.claimedLines, checkBudget);

  return {
    statement: {
      from: header.from,
      to: header.to,
      openingBalance: header.openingBalance,
      closingBalance: header.closingBalance,
      rows: [...rows],
      problems: [...problems],
      maturityDate: header.maturityDate,
    },
    rowBalances,
    unclaimed,
    skipped,
  };
};
