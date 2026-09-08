import { EUR, formatMoney, money } from "../../../core/money.ts";
import { verifyStatement } from "../bank-pdf.ts";
import type { BankRow } from "../bank-statement.ts";
import type { RecipeRun, Skipped, Unclaimed } from "./run.ts";

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly report: string };

/** Enough for the model to see the pattern, short enough to stay a prompt. */
const MAX_LISTED = 10;

const eur = (minor: bigint): string => formatMoney(money(minor, EUR));

/**
 * An unclaimed line before the first transaction row is tolerated: OP's
 * preamble prints the account holder's name there (`ESIMERKKI ASIAKAS`), and
 * no honest pattern covers page furniture that never repeats. When there are
 * no rows at all the recipe failed to read the statement entirely, so nothing
 * counts as "before the first row" -- every unclaimed line then fails.
 */
const isPreamble = (entry: Unclaimed, rows: readonly BankRow[]): boolean => {
  if (rows.length === 0) return false;
  const firstRowLine = Math.min(...rows.map((row) => row.line));
  return entry.line < firstRowLine;
};

/**
 * Probes for "this line was a transaction", written here rather than taken
 * from the recipe: the recipe is what is under suspicion, so its own patterns
 * cannot be the evidence. Deliberately narrow -- a printed date and a printed
 * two-decimal amount -- so page furniture (an IBAN, `1 (2)`, a period line, a
 * card number with `OSTOPVM 250828`, a `5 000,00 Panot yhteensä` total) does
 * not trip it. Balance lines carry both, and are excluded upstream because a
 * header pattern accounts for them.
 */
const DATE_LIKE = /(?<!\d)(?:\d{1,2}\.\d{1,2}\.\d{4}|\d{4}-\d{2}-\d{2})(?!\d)/u;
const AMOUNT_LIKE = /(?<![\d.,])[+\-\u2212]?\d{1,3}(?:[  .,]\d{3})*[.,]\d{2}(?![\d.,])/u;

/**
 * A line `skip` removed that still says when and how much. `skip` satisfies
 * coverage by definition, and a cancelling pair of transfers satisfies the
 * arithmetic, so without this check the two together hide real money.
 */
const looksLikeTransaction = (entry: Skipped): boolean =>
  DATE_LIKE.test(entry.text) && AMOUNT_LIKE.test(entry.text);

export const verifyRun = ({ statement, unclaimed, skipped }: RecipeRun): Verdict => {
  const complaints: string[] = [];

  const failing = unclaimed.filter((entry) => !isPreamble(entry, statement.rows));
  if (failing.length > 0) {
    const listed = failing
      .slice(0, MAX_LISTED)
      .map((entry) => `  #${entry.line}: ${JSON.stringify(entry.text)}`)
      .join("\n");
    complaints.push(`Kuvaus jätti ${failing.length} riviä tunnistamatta:\n${listed}`);
  }

  const eaten = skipped.filter(looksLikeTransaction);
  if (eaten.length > 0) {
    const listed = eaten
      .slice(0, MAX_LISTED)
      .map((entry) => `  #${entry.line}: ${JSON.stringify(entry.text)}`)
      .join("\n");
    complaints.push(
      `Ohitettujen rivien joukossa on ${eaten.length} riviä, joilla on sekä päivä ` +
        `että summa -- ne näyttävät tapahtumilta:\n${listed}`,
    );
  }

  const check = verifyStatement(statement);
  if (!check.ok) {
    complaints.push(
      `Saldotarkistus: alkusaldo ${eur(statement.openingBalance.minor)} + rivit = ` +
        `${eur(check.actualEur)}, ote tulostaa ${eur(check.expectedEur)} ` +
        `(ero ${eur(check.differenceEur)}).`,
    );
  }

  const outside = statement.rows.filter(
    (row) => row.date < statement.from || row.date > statement.to,
  );
  if (outside.length > 0) {
    complaints.push(
      `Jakson ${statement.from}…${statement.to} ulkopuolisia päiviä: ` +
        outside
          .slice(0, MAX_LISTED)
          .map((row) => row.date)
          .join(", "),
    );
  }

  return complaints.length === 0 ? { ok: true } : { ok: false, report: complaints.join("\n\n") };
};
