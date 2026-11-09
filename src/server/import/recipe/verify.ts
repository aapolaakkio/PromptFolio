import { EUR, formatMoney, money } from "../../../core/money.ts";
import { verifyStatement } from "../bank-pdf.ts";
import type { BankRow } from "../bank-statement.ts";
import type { RecipeRun, Unclaimed } from "./run.ts";

type Verdict = { readonly ok: true } | { readonly ok: false; readonly report: string };

const MAX_LISTED = 10;

export const eur = (minor: bigint): string => formatMoney(money(minor, EUR));

/** OP preamble prints the holder name before the first row, so an unclaimed line there is tolerated. */
const isPreamble = (entry: Unclaimed, rows: readonly BankRow[]): boolean => {
  if (rows.length === 0) return false;
  const firstRowLine = Math.min(...rows.map((row) => row.line));
  return entry.line < firstRowLine;
};

/** Probes written here, not taken from the suspect recipe; both must hit (a period line has dates but no amount, a totals line the reverse). Not caught: a date on a different line from its amount. */
const DATE_SEPARATOR = String.raw`[./-]`;
const DAY_FIRST = String.raw`\d{1,2}${DATE_SEPARATOR}\d{1,2}${DATE_SEPARATOR}\d{2}(?:\d{2})?`;
const YEAR_FIRST = String.raw`\d{4}${DATE_SEPARATOR}\d{1,2}${DATE_SEPARATOR}\d{1,2}`;
const DATE_LIKE = new RegExp(String.raw`(?<!\d)(?:${DAY_FIRST}|${YEAR_FIRST})(?!\d)`, "u");

const SIGN = "[+\\-\\u2212]?";
const DIGIT_GROUPS = String.raw`\d{1,3}(?:[  .,]\d{3})*`;
const AMOUNT_LIKE = new RegExp(
  String.raw`(?<![\d.,])${SIGN}${DIGIT_GROUPS}(?:[.,]\d{2,3})?(?![\d.,])`,
  "u",
);

/** skip plus a cancelling pair satisfies coverage and arithmetic, hiding real money. */
export const looksLikeTransaction = (entry: { readonly text: string }): boolean =>
  DATE_LIKE.test(entry.text) && AMOUNT_LIKE.test(entry.text);

export const unclaimedWorthReporting = ({
  statement,
  unclaimed,
}: RecipeRun): readonly Unclaimed[] =>
  unclaimed.filter((entry) => !isPreamble(entry, statement.rows) && looksLikeTransaction(entry));

/** Catches a misread amount and its mirror image; every row needs a balance. */
const firstBrokenLink = ({
  statement,
  rowBalances,
}: RecipeRun): {
  readonly row: BankRow;
  readonly expected: bigint;
  readonly printed: bigint;
} | null => {
  const { rows } = statement;
  if (rows.length === 0 || rowBalances.length !== rows.length) return null;
  if (rowBalances.some((balance) => balance === null)) return null;

  let running = statement.openingBalance.minor;
  for (const [at, row] of rows.entries()) {
    running += row.amount;
    const printed = rowBalances[at]!;
    if (printed !== running) return { row, expected: running, printed };
  }
  return null;
};

export const verifyRun = (recipeRun: RecipeRun): Verdict => {
  const { statement, skipped } = recipeRun;
  const complaints: string[] = [];

  const failing = unclaimedWorthReporting(recipeRun);
  if (failing.length > 0) {
    const listed = failing
      .slice(0, MAX_LISTED)
      .map((entry) => `  #${entry.line}: ${JSON.stringify(entry.text)}`)
      .join("\n");
    complaints.push(`The recipe left ${failing.length} lines unrecognised:\n${listed}`);
  }

  const eaten = skipped.filter(looksLikeTransaction);
  if (eaten.length > 0) {
    const listed = eaten
      .slice(0, MAX_LISTED)
      .map((entry) => `  #${entry.line}: ${JSON.stringify(entry.text)}`)
      .join("\n");
    complaints.push(
      `Among the skipped lines are ${eaten.length} with both a date and an amount ` +
        `-- they look like transactions:\n${listed}`,
    );
  }

  const broken = firstBrokenLink(recipeRun);
  if (broken !== null) {
    complaints.push(
      `After row #${broken.row.line} the running balance would be ${eur(broken.expected)}, ` +
        `but the statement prints ${eur(broken.printed)} -- the row was misread.`,
    );
  }

  const check = verifyStatement(statement);
  if (!check.ok) {
    complaints.push(
      `Balance check: opening balance ${eur(statement.openingBalance.minor)} + rows = ` +
        `${eur(check.actualEur)}, the statement prints ${eur(check.expectedEur)} ` +
        `(difference ${eur(check.differenceEur)}).`,
    );
  }

  const outside = statement.rows.filter(
    (row) => row.date < statement.from || row.date > statement.to,
  );
  if (outside.length > 0) {
    complaints.push(
      `Dates outside the period ${statement.from}…${statement.to}: ` +
        outside
          .slice(0, MAX_LISTED)
          .map((row) => row.date)
          .join(", "),
    );
  }

  return complaints.length === 0 ? { ok: true } : { ok: false, report: complaints.join("\n\n") };
};
