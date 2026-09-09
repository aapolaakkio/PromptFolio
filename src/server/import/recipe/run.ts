import { EUR, money, type Money } from "../../../core/money.ts";
import type { PdfStatement } from "../bank-pdf.ts";
import type { BankRow } from "../bank-statement.ts";
import { readDate } from "./date-format.ts";
import { readAmount, readTwoColumn } from "./money-format.ts";
import type { BankRecipe } from "./types.ts";

export type Unclaimed = { readonly line: number; readonly text: string };
/** A line `skip` dropped that no header pattern accounted for. */
export type Skipped = { readonly line: number; readonly text: string };
export type RecipeRun = {
  readonly statement: PdfStatement;
  /**
   * The balance each row printed beside itself, in `statement.rows` order, or
   * null where the recipe named none. A statement that prints a running
   * balance is stating what it thinks the account held after every single row
   * -- the one check that can see a wrong amount on one row, which the totals
   * cannot: an error and its mirror image add up.
   */
  readonly rowBalances: readonly (bigint | null)[];
  readonly unclaimed: readonly Unclaimed[];
  /**
   * What `skip` removed on its own account. Coverage cannot see these -- that
   * is what `skip` means -- so verification looks at them separately: a skipped
   * line carrying both a date and an amount is money the recipe threw away.
   */
  readonly skipped: readonly Skipped[];
};

/**
 * The time budget ran out. Distinguished from every other failure because a
 * stored recipe that trips it will trip it again on every future import, so
 * the caller must be able to tell it apart and let it surface.
 */
export class RecipeTimeoutError extends Error {
  constructor() {
    super("Tiliotteen lukeminen kesti liian kauan");
    this.name = "RecipeTimeoutError";
  }
}

/** A model wrote these patterns, so the loop that runs them is watched. */
const TIME_BUDGET_MS = 5_000;
const CHECK_EVERY = 200;

/**
 * Throws once elapsed time crosses the budget: on the first call and every
 * `CHECK_EVERY` after. The first call matters -- a single `exec` can spend the
 * whole budget on its own, and the loop that follows it must notice at once
 * rather than 200 patterns later.
 */
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

/**
 * @param lines The document with every record-start line blanked out. A header
 *   pattern broad enough to also match a transaction must not read a fact off
 *   one, nor claim it as furniture: on a statement with a running-balance
 *   column that turns the opening balance into `opening + row1`, which cancels
 *   a missing row exactly and lets a wrong reading pass every check.
 */
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

/** The Finnish name of every header fact a statement must have, in recipe order. */
const REQUIRED_FACTS = [
  ["from", "jakson alku"],
  ["to", "jakson loppu"],
  ["openingBalance", "alkusaldo"],
  ["closingBalance", "loppusaldo"],
] as const;

/**
 * Validates the facts a statement must have, then converts them. Throws only here.
 *
 * The complaint names the facts that are actually missing. It used to say
 * "alku- ja loppusaldoa" whatever was absent, so a recipe that had read both
 * balances and missed the period sent the owner -- and the model retrying --
 * looking at the one part of the statement that had been read correctly.
 */
const buildStatementHeader = (facts: HeaderFacts, recipe: BankRecipe): StatementHeader => {
  const missing = REQUIRED_FACTS.filter(([key]) => facts[key] === null).map(([, name]) => name);
  if (missing.length > 0) {
    throw new Error(`Tiliotteesta ei löytynyt: ${missing.join(", ")}`);
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
 *
 * A header pattern may not claim a record-start line. An over-broad one that
 * also matches transactions would otherwise take them out of coverage, and a
 * line that says when and how much is a transaction first and furniture never.
 */
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

/**
 * What `skip` dropped without any header pattern also covering it. Reported so
 * verification can look for money inside it: `skip` satisfies coverage by
 * definition, so a pattern eating a transaction leaves no other trace.
 */
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

/**
 * The running balance a row printed, or null. Unreadable is null rather than a
 * problem: a row the statement did read is not worth refusing over a column
 * the check is only allowed to use when every row has it.
 */
const readBalance = (text: string | undefined, recipe: BankRecipe): bigint | null => {
  if (text === undefined) return null;
  try {
    return readAmount(text, recipe.money);
  } catch {
    return null;
  }
};

/** The row itself, or a `problem` when reading it throws -- never both, never an exception. */
const buildRowOutcome = (
  groups: Readonly<Record<string, string | undefined>>,
  fields: Readonly<Record<string, string>>,
  recipe: BankRecipe,
  start: number,
  yearHint: string,
) => {
  // One record, one set of fields, whichever line named them. The record-start
  // line wins a clash -- it is the more specific place to have said something --
  // and everything else reads the same way, so no field is tied to a position.
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
      type: rowType(note, amount),
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
        message: cause instanceof Error ? cause.message : "Rivin käsittely epäonnistui",
      },
    };
  }
};

type BlockOutcome = {
  readonly row: BankRow | null;
  readonly problem: { readonly line: number; readonly message: string } | null;
  /** What the row printed as the balance after it, when the recipe named one. */
  readonly balance: bigint | null;
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
  /** Index-aligned with `rows`: what each printed as the balance after it. */
  readonly rowBalances: readonly (bigint | null)[];
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

  const starts = findRecordStarts(lines, recordStart, skip, checkBudget);
  const startLines = new Set(starts);
  // The header pass never sees a line that opens a record; see resolveHeaderFacts.
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
