import { EUR, formatMoney, money } from "../../../core/money.ts";
import { verifyStatement } from "../bank-pdf.ts";
import type { BankRow } from "../bank-statement.ts";
import type { RecipeRun, Unclaimed } from "./run.ts";

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

export const verifyRun = ({ statement, unclaimed }: RecipeRun): Verdict => {
  const complaints: string[] = [];

  const failing = unclaimed.filter((entry) => !isPreamble(entry, statement.rows));
  if (failing.length > 0) {
    const listed = failing
      .slice(0, MAX_LISTED)
      .map((entry) => `  #${entry.line}: ${JSON.stringify(entry.text)}`)
      .join("\n");
    complaints.push(`Kuvaus jätti ${failing.length} riviä tunnistamatta:\n${listed}`);
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
