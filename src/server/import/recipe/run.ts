import { EUR, money } from "../../../core/money.ts";
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

/**
 * First match for an opening fact, last for a closing one. Tried line by line
 * first -- most header facts sit on one line -- and only when no line matches
 * against the whole document joined with newlines, so a pattern may span a
 * label and its value printed on separate lines (`Eräpäivä\n1.2.2027`).
 */
const headerFact = (lines: readonly string[], source: string | undefined, last: boolean) => {
  if (source === undefined) return null;
  const pattern = compile(source);
  const perLine = lines.flatMap((line) => {
    const match = pattern.exec(line);
    return match ? [groupValue(match)] : [];
  });
  if (perLine.length > 0) return (last ? perLine.at(-1) : perLine[0]) ?? null;
  const whole = pattern.exec(lines.join("\n"));
  return whole ? groupValue(whole) : null;
};

const rowType = (note: string, amount: bigint): BankRow["type"] => {
  if (amount > 0n && /korko/i.test(note)) return "INTEREST";
  return amount < 0n ? "WITHDRAWAL" : "DEPOSIT";
};

/** Which of a block's lines a match covers, given the block joined with newlines. */
const linesCovered = (block: readonly string[], start: number, end: number): Set<number> => {
  const covered = new Set<number>();
  let at = 0;
  for (const [index, line] of block.entries()) {
    const lineEnd = at + line.length;
    if (start < lineEnd && end > at) covered.add(index);
    at = lineEnd + 1;
  }
  return covered;
};

export const runRecipe = (text: string, recipe: BankRecipe): RecipeRun => {
  const started = Date.now();
  const lines = text.split("\n").map((line) => line.trim());
  const skip = compileAll(recipe.skip);
  const recordStart = compile(recipe.recordStart);
  const continuation = compileAll(recipe.continuation);

  const fromText = headerFact(lines, recipe.header.from, false);
  const toText = headerFact(lines, recipe.header.to, true);
  const openingText = headerFact(lines, recipe.header.openingBalance, false);
  const closingText = headerFact(lines, recipe.header.closingBalance, true);
  if (fromText === null || toText === null || openingText === null || closingText === null) {
    throw new Error("Tiliotteesta ei löytynyt alku- ja loppusaldoa");
  }
  const from = readDate(fromText, recipe.dateFormat);
  const to = readDate(toText, recipe.dateFormat);
  const yearHint = to.slice(0, 4);

  const maturityText = headerFact(lines, recipe.header.maturityDate, false);
  const maturityDate =
    maturityText === null ? null : readDate(maturityText, recipe.dateFormat, yearHint);

  const rows: BankRow[] = [];
  const problems: Array<{ line: number; message: string }> = [];
  const unclaimed: Unclaimed[] = [];

  const starts = lines.flatMap((line, index) => (recordStart.test(line) ? [index] : []));

  /**
   * A header pattern names a structural fact (a balance, a period bound), not
   * a record field. Without this, a balance line trailing the last record
   * falls inside that record's block -- there is no next `recordStart` to end
   * it at -- and is wrongly reported as unclaimed furniture.
   */
  const headerPatterns = [
    recipe.header.from,
    recipe.header.to,
    recipe.header.openingBalance,
    recipe.header.closingBalance,
    recipe.header.maturityDate,
  ]
    .filter((source): source is string => source !== undefined)
    .map(compile);

  const claimed = new Set<number>(starts);
  for (const [index, line] of lines.entries()) {
    const isHeaderLine = headerPatterns.some((pattern) => pattern.test(line));
    if (line === "" || isHeaderLine || skip.some((pattern) => pattern.test(line))) {
      claimed.add(index);
    }
  }

  for (const [order, start] of starts.entries()) {
    if (order % CHECK_EVERY === 0 && Date.now() - started > TIME_BUDGET_MS) {
      throw new Error("Tiliotteen lukeminen kesti liian kauan");
    }
    const end = starts[order + 1] ?? lines.length;
    const blockIndexes = Array.from(
      { length: end - start - 1 },
      (_, offset) => start + 1 + offset,
    ).filter((index) => !claimed.has(index));
    const block = blockIndexes.map((index) => lines[index] ?? "");
    const joined = block.join("\n");

    const fields: Record<string, string> = {};
    const consumed = new Set<number>();
    for (const pattern of continuation) {
      const match = pattern.exec(joined);
      if (!match) continue;
      for (const [name, value] of Object.entries(match.groups ?? {})) {
        if (value !== undefined && fields[name] === undefined) fields[name] = value;
      }
      for (const covered of linesCovered(block, match.index, match.index + match[0].length)) {
        consumed.add(covered);
      }
    }

    const remaining = block.flatMap((value, at) => (consumed.has(at) ? [] : [{ value, at }]));
    const rest = remaining[0];
    if (recipe.restField !== null && rest !== undefined) {
      fields[recipe.restField] ??= rest.value;
      consumed.add(rest.at);
    }
    for (const { value, at } of remaining) {
      if (!consumed.has(at)) unclaimed.push({ line: (blockIndexes[at] ?? 0) + 1, text: value });
    }

    const head = recordStart.exec(lines[start] ?? "");
    const groups = { ...head?.groups };
    try {
      const amount = recipe.money.twoColumn
        ? readTwoColumn(groups.debit ?? "", groups.credit ?? "", recipe.money)
        : readAmount(groups.amount ?? "", recipe.money);
      const counterparty = fields.counterparty ?? groups.counterparty ?? "";
      const note = [groups.label ?? "", counterparty, fields.message ?? ""]
        .map((part) => part.trim())
        .filter((part) => part !== "")
        .join(" — ");
      rows.push({
        line: start + 1,
        date: readDate(groups.date ?? "", recipe.dateFormat, yearHint),
        type: rowType(note, amount),
        amount,
        counterparty,
        note,
        externalId: groups.externalId ?? fields.externalId ?? null,
      });
    } catch (cause) {
      problems.push({
        line: start + 1,
        message: cause instanceof Error ? cause.message : "Rivin käsittely epäonnistui",
      });
    }
  }

  return {
    statement: {
      from,
      to,
      openingBalance: money(readAmount(openingText, recipe.money), EUR),
      closingBalance: money(readAmount(closingText, recipe.money), EUR),
      rows,
      problems,
      maturityDate,
    },
    unclaimed,
  };
};
