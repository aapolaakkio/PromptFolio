import { EUR, money, type Money } from "../../../core/money.ts";
import type { PdfStatement } from "../bank-pdf.ts";
import type { BankRow } from "../bank-statement.ts";
import { readDate } from "./date-format.ts";
import { readAmount, readTwoColumn } from "./money-format.ts";
import type { BankRecipe } from "./types.ts";

export type Unclaimed = { readonly line: number; readonly text: string };
export type RecipeRun = {
  readonly statement: PdfStatement;
  readonly unclaimed: readonly Unclaimed[];
};

/** A model wrote these patterns, so the loop that runs them is watched. */
const TIME_BUDGET_MS = 5_000;
const CHECK_EVERY = 200;

/** Throws once elapsed time crosses the budget, checked every `CHECK_EVERY` call. */
const makeBudgetChecker = (budgetMs: number): (() => void) => {
  const started = Date.now();
  let ticks = 0;
  return () => {
    ticks += 1;
    if (ticks % CHECK_EVERY === 0 && Date.now() - started > budgetMs) {
      throw new Error("Tiliotteen lukeminen kesti liian kauan");
    }
  };
};

/**
 * `m` so a continuation or header-fallback pattern's `^`/`$` anchor to a line
 * inside a joined multi-line block or document, not only to the very start and
 * end of the whole joined text. A single-line match (skip, recordStart, the
 * per-line header pass) is unaffected: there is no embedded newline for `m` to
 * change the meaning of.
 */
const compile = (source: string): RegExp => new RegExp(source, "um");
const compileAll = (sources: readonly string[]): RegExp[] => sources.map(compile);

const groupValue = (match: RegExpExecArray): string | null =>
  match.groups?.value ?? match[1] ?? null;

const rowType = (note: string, amount: bigint): BankRow["type"] => {
  if (amount > 0n && /korko/i.test(note)) return "INTEREST";
  return amount < 0n ? "WITHDRAWAL" : "DEPOSIT";
};

/** Which of a set of lines (joined with `\n`) a match's [start, end) span covers. */
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

/**
 * Only the first and last of a set of line indexes. A model's fallback
 * pattern may be greedy or lazy across half a page; claiming everything it
 * spans would silently drop whatever furniture sat in between. A genuine
 * two-line header fact (a label, then its value) still claims exactly those
 * two lines; a single-line span claims just that one line.
 */
const firstAndLast = (indexes: ReadonlySet<number>): Set<number> => {
  if (indexes.size === 0) return new Set();
  const sorted = [...indexes].sort((a, b) => a - b);
  return new Set([sorted[0]!, sorted.at(-1)!]);
};

/**
 * One header fact: first match for an opening fact, last for a closing one.
 * Tried line by line first -- most header facts sit on one line -- and only
 * when no line matches, against the whole document joined with newlines, so a
 * pattern may span a label and its value on separate lines
 * (`Eräpäivä\n1.2.2027`). A fallback match claims only the first and last
 * line of its span (see `firstAndLast`) so the caller can claim them; a line
 * match needs no such report, since a global per-line header sweep already
 * claims every line any header pattern matches.
 */
const readHeaderField = (lines: readonly string[], source: string | undefined, last: boolean) => {
  const noFallback = new Set<number>();
  if (source === undefined) return { value: null, claimedByFallback: noFallback };
  const pattern = compile(source);
  const perLine = lines.flatMap((line) => {
    const match = pattern.exec(line);
    return match ? [groupValue(match)] : [];
  });
  if (perLine.length > 0) {
    return { value: (last ? perLine.at(-1) : perLine[0]) ?? null, claimedByFallback: noFallback };
  }
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

const resolveHeaderFacts = (
  lines: readonly string[],
  header: BankRecipe["header"],
): HeaderFacts => {
  const claimedLines = new Set<number>();
  const read = (source: string | undefined, last: boolean): string | null => {
    const { value, claimedByFallback } = readHeaderField(lines, source, last);
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

/** Validates the facts a statement must have, then converts them. Throws only here. */
const buildStatementHeader = (facts: HeaderFacts, recipe: BankRecipe): StatementHeader => {
  if (
    facts.from === null ||
    facts.to === null ||
    facts.openingBalance === null ||
    facts.closingBalance === null
  ) {
    throw new Error("Tiliotteesta ei löytynyt alku- ja loppusaldoa");
  }
  const from = readDate(facts.from, recipe.dateFormat);
  const to = readDate(facts.to, recipe.dateFormat);
  const yearHint = to.slice(0, 4);
  const maturityDate =
    facts.maturityDate === null ? null : readDate(facts.maturityDate, recipe.dateFormat, yearHint);
  return {
    from,
    to,
    yearHint,
    maturityDate,
    openingBalance: money(readAmount(facts.openingBalance, recipe.money), EUR),
    closingBalance: money(readAmount(facts.closingBalance, recipe.money), EUR),
  };
};

/** A line matching `skip` is dropped rather than opening a record: `skip` wins. */
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

/**
 * Every line no record block will ever see: blank, `skip`-matched, matching a
 * header pattern (a structural fact, not a record field), a record-start
 * itself, or covered by a multi-line header fallback match.
 */
const buildClaimed = (
  lines: readonly string[],
  starts: readonly number[],
  skip: readonly RegExp[],
  headerPatterns: readonly RegExp[],
  headerFallbackClaims: ReadonlySet<number>,
  checkBudget: () => void,
): Set<number> => {
  const claimed = new Set<number>([...starts, ...headerFallbackClaims]);
  for (const [index, line] of lines.entries()) {
    checkBudget();
    const isHeaderLine = headerPatterns.some((pattern) => pattern.test(line));
    if (line === "" || isHeaderLine || skip.some((pattern) => pattern.test(line))) {
      claimed.add(index);
    }
  }
  return claimed;
};

type BlockFields = {
  readonly fields: Readonly<Record<string, string>>;
  readonly consumedLocal: ReadonlySet<number>;
};

/**
 * A block's fields, in precedence order: `recordStart`'s own named groups
 * (`groups`, read by the caller) win outright; `continuation` patterns fill
 * what is left; `restField` only takes the first still-unclaimed line when
 * neither of those already named it. A field `restField` does not assign to
 * leaves its candidate line unconsumed, so the caller reports it unclaimed
 * instead of silently dropping it.
 */
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

/** The row itself, or a `problem` when reading it throws -- never both, never an exception. */
const buildRowOutcome = (
  groups: Readonly<Record<string, string | undefined>>,
  fields: Readonly<Record<string, string>>,
  recipe: BankRecipe,
  start: number,
  yearHint: string,
) => {
  try {
    const amount = recipe.money.twoColumn
      ? readTwoColumn(groups.debit ?? "", groups.credit ?? "", recipe.money)
      : readAmount(groups.amount ?? "", recipe.money);
    const counterparty = groups.counterparty ?? fields.counterparty ?? "";
    const note = [groups.label ?? "", counterparty, fields.message ?? ""]
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .join(" — ");
    const row: BankRow = {
      line: start + 1,
      date: readDate(groups.date ?? "", recipe.dateFormat, yearHint),
      type: rowType(note, amount),
      amount,
      counterparty,
      note,
      externalId: groups.externalId ?? fields.externalId ?? null,
    };
    return { row, problem: null };
  } catch (cause) {
    return {
      row: null,
      problem: {
        line: start + 1,
        message: cause instanceof Error ? cause.message : "Rivin käsittely epäonnistui",
      },
    };
  }
};

type BlockOutcome = {
  readonly row: BankRow | null;
  readonly problem: { readonly line: number; readonly message: string } | null;
  readonly consumedIndexes: ReadonlySet<number>;
};

/** One record: its block's fields, then the row itself, or a `problem` if reading it throws. */
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
  readonly problems: readonly { readonly line: number; readonly message: string }[];
  readonly consumed: ReadonlySet<number>;
};

/** Every record in turn: its row or problem, and which lines it consumed. */
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
    if (outcome.row !== null) rows.push(outcome.row);
    if (outcome.problem !== null) problems.push(outcome.problem);
    for (const index of outcome.consumedIndexes) consumed.add(index);
  }
  return { rows, problems, consumed };
};

/** Every line no header, `skip`, record start, or block claimed. */
const findUnclaimed = (
  lines: readonly string[],
  claimed: ReadonlySet<number>,
  consumed: ReadonlySet<number>,
): Unclaimed[] =>
  lines.flatMap((line, index) =>
    claimed.has(index) || consumed.has(index) ? [] : [{ line: index + 1, text: line }],
  );

/**
 * @param budgetMs Overrides the default time budget; for tests that need a
 *   pathological input to trip it without an actually slow pattern.
 */
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

  const facts = resolveHeaderFacts(lines, recipe.header);
  const header = buildStatementHeader(facts, recipe);

  const starts = findRecordStarts(lines, recordStart, skip, checkBudget);
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

  const { rows, problems, consumed } = readRecords(
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
    unclaimed,
  };
};
