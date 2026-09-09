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

/**
 * Probes for "this line was a transaction", written here rather than taken
 * from the recipe: the recipe is what is under suspicion, so its own patterns
 * cannot be the evidence. Both must hit for a skipped line to be flagged --
 * the period line `29.8.2025 - 28.8.2026` prints two dates and no amount, and
 * a totals line `5 000,00 Panot yhteensä 1 kpl` an amount and no date, so
 * either probe alone would fail every OP import.
 *
 * The date probe knows a two- or four-digit year, `.` `/` `-` as separators,
 * and both day-first and year-first order. The amount probe knows a sign or no
 * sign, a thousands separator or none, and zero, two or three decimals: an
 * evasion is only worth naming once, and `1.8.26 -250 SIIRTO` hides exactly as
 * much money as `1.9.2026 −250,00 SIIRTO`. Page furniture stays quiet because
 * the guards keep a date's own digit groups from reading as a bare amount (an
 * IBAN, `1 (1)`, `400000******0000 OSTOPVM 250828`, `Asiakkaan tulostama
 * 1.3.2026`).
 *
 * Two evasions this does NOT catch, stated so the next reader is not misled:
 *
 * - A date printed on a different line from its amount. The probe reads one
 *   line at a time, so a two-line record split across two skipped lines shows
 *   neither probe a complete transaction.
 * - A skipped line that a header pattern also matches. Those never reach here
 *   (`run.ts` records them as accounted for), which is what keeps the balance
 *   line `5 000,00 Saldo 28.8.2026` -- a real date and a real amount -- quiet.
 *   A recipe that writes a header pattern loose enough to cover transaction
 *   rows walks through that door; only the balance arithmetic is left to stop
 *   it, and a cancelling pair of transfers satisfies the arithmetic.
 */
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

/**
 * A line `skip` removed that still says when and how much. `skip` satisfies
 * coverage by definition, and a cancelling pair of transfers satisfies the
 * arithmetic, so without this check the two together hide real money.
 */
export const looksLikeTransaction = (entry: { readonly text: string }): boolean =>
  DATE_LIKE.test(entry.text) && AMOUNT_LIKE.test(entry.text);

/**
 * The unclaimed lines worth anyone's attention. A record block is every line
 * from its start to the next one, so an ordinary transaction carries detail
 * lines no honest pattern names -- `VIESTI`, `Maksajan viite:`, a reference,
 * an address, a page footer. Reporting those made a correct reading look
 * broken to the owner and sent the model chasing patterns for furniture.
 *
 * What is left is the failure the list exists for: a transaction `recordStart`
 * missed, swallowed into the block above it. It still prints a date and an
 * amount, so the same probe the skipped lines get finds it here.
 */
export const unclaimedWorthReporting = ({
  statement,
  unclaimed,
}: RecipeRun): readonly Unclaimed[] =>
  unclaimed.filter((entry) => !isPreamble(entry, statement.rows) && looksLikeTransaction(entry));

export const verifyRun = ({ statement, unclaimed, skipped }: RecipeRun): Verdict => {
  const complaints: string[] = [];

  const failing = unclaimedWorthReporting({ statement, unclaimed, skipped });
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
