import { EUR, parseMoney, type Money } from "../../core/money.ts";
import type { IsoDate } from "../../core/types.ts";
import { rowType, type BankRow } from "./bank-statement.ts";
import { assertReal } from "./recipe/date-format.ts";

/** Opening plus every parsed row must equal the printed closing balance, so a mis-parse cannot pass silently. */
export type PdfStatement = {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly openingBalance: Money;
  readonly closingBalance: Money;
  readonly rows: BankRow[];
  readonly problems: Array<{ line: number; message: string }>;
  readonly maturityDate: IsoDate | null;
};

/** OP prints U+2212 as the minus and a non-breaking space as the thousands separator. */
const normaliseAmount = (text: string): string =>
  text
    .replace(/−/g, "-")
    .replace(/[\s\u00a0]/g, "")
    .replace(/^\+/, "")
    .replace(",", ".");

/** extraction can join fragments into a non-date */
const toIsoDate = (text: string): IsoDate => {
  const [day, month, year] = text.split(".");
  if (day === undefined || month === undefined || year === undefined) {
    throw new Error(`Could not read date: "${text}"`);
  }
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return assertReal(iso, text);
};

const DATE = String.raw`\d{1,2}\.\d{1,2}\.\d{4}`;
const AMOUNT = String.raw`[+−-]?\d{1,3}(?:[  ]\d{3})*,\d{2}`;

const HEADER = new RegExp(`^(${DATE})\\s+(${AMOUNT})\\s+(.*)$`);

const BALANCE = new RegExp(`^(${AMOUNT})\\s+Saldo\\s+(${DATE})$`);

const FURNITURE =
  /^(Tilinumero|BIC|Kirjaus-|päivä|Arvopäivä|Määrä,|euroa|Selitys|Maksunsaaja\/maksaja|Viesti$|Viite|Saajan|Tiliote|Käyttötili|Määräaikainen|Eräpäivä|Ajalta|Asiakkaan tulostama|Jatkuu|\d+ \(\d+\)$)/;

const BIC_LINE = /^[A-Z]{6}[A-Z0-9]{2,5}$/;

const IBAN_LINE = /^[A-Z]{2}\d{2}(\s\d{4})+(\s\d{1,4})?$/;
const IBAN_INSIDE = /[A-Z]{2}\d{2}(\s\d{4})+(\s\d{1,4})?/;

const PERIOD_LINE = new RegExp(`^${DATE}\\s*-\\s*${DATE}$`);

const TERMINAL_NOISE = /^(\d{6}\*+\d{4}|MF NRO|VARMENTAJA|OSTOPVM)/;

const MATURITY = /^Eräpäivä$/;
const MATURITY_DATE = new RegExp(`^${DATE}$`);

/** The payment reference is not used: repeated rent payments share one. */
const ARCHIVE_ID = /^[0-9A-Z]{16,}$/;

const archiveIdOf = (tail: string, following: readonly string[]): string | null => {
  const tokens = tail.trim().split(/\s+/);
  const withoutFlag =
    tokens.length > 1 && /^[A-Z]$/.test(tokens.at(-1) ?? "") ? tokens.slice(0, -1) : tokens;
  const onHeader = withoutFlag.at(-1) ?? "";
  if (ARCHIVE_ID.test(onHeader)) return onHeader;

  return following.find((line) => ARCHIVE_ID.test(line)) ?? null;
};

const labelOf = (tail: string): string => {
  const words: string[] = [];
  for (const token of tail.trim().split(/\s+/)) {
    if (!/^[A-ZÄÖÅ][A-ZÄÖÅ.-]*$/.test(token)) break;
    words.push(token);
  }
  return words.join(" ");
};

const INTEREST_LABELS = ["TALLETUSKORKO", "KORKO"];

export const parseOpStatementText = (text: string): PdfStatement => {
  const lines = text.split("\n").map((line) => line.trim());
  const problems: Array<{ line: number; message: string }> = [];

  const ownAccount = ((): string => {
    const labelled = lines.findIndex((line) => line.startsWith("Tilinumero"));
    if (labelled === -1) return "";
    const inline = IBAN_INSIDE.exec(lines[labelled] ?? "");
    if (inline?.[0] !== undefined) return inline[0];
    return lines.slice(labelled + 1, labelled + 6).find((line) => IBAN_LINE.test(line)) ?? "";
  })();

  const balances: Array<{ amount: Money; date: IsoDate }> = [];
  for (const line of lines) {
    const match = BALANCE.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      balances.push({
        amount: parseMoney(normaliseAmount(match[1]), EUR),
        date: toIsoDate(match[2]),
      });
    }
  }
  const opening = balances[0];
  const closing = balances.at(-1);
  if (!opening || !closing || balances.length < 2) {
    throw new Error(
      "No opening and closing balance found in the statement; check that the file is an OP bank statement",
    );
  }

  const rows: BankRow[] = [];
  for (const [index, line] of lines.entries()) {
    const match = HEADER.exec(line);
    if (!match) continue;
    const [, dateText, amountText, tail = ""] = match;
    if (dateText === undefined || amountText === undefined) continue;

    try {
      const amount = parseMoney(normaliseAmount(amountText), EUR).minor;
      const label = labelOf(tail);

      // Scanned to the next transaction, not a fixed few lines: a page break puts the whole header between.
      const following: string[] = [];
      for (let ahead = index + 1; ahead < lines.length; ahead++) {
        const candidate = lines[ahead] ?? "";
        if (HEADER.test(candidate) || BALANCE.test(candidate)) break;
        following.push(candidate);
      }
      const usable = following.filter(
        (candidate) =>
          candidate !== "" &&
          !FURNITURE.test(candidate) &&
          !PERIOD_LINE.test(candidate) &&
          !TERMINAL_NOISE.test(candidate) &&
          !BIC_LINE.test(candidate) &&
          candidate !== ownAccount,
      );
      const counterparty = usable.find((candidate) => !candidate.startsWith("Viesti:")) ?? "";

      const messageAt = usable.findIndex((candidate) => candidate.startsWith("Viesti:"));
      const message =
        messageAt === -1
          ? ""
          : (usable.slice(messageAt + 1).find((candidate) => candidate !== counterparty) ?? "");

      rows.push({
        line: index + 1,
        date: toIsoDate(dateText),
        type: rowType(label, amount, INTEREST_LABELS),
        amount,
        counterparty,
        note: [label, counterparty, message].filter((part) => part !== "").join(" — "),
        externalId: archiveIdOf(tail, following),
      });
    } catch (cause) {
      problems.push({
        line: index + 1,
        message: cause instanceof Error ? cause.message : "Processing the row failed",
      });
    }
  }

  const maturityIndex = lines.findIndex((line) => MATURITY.test(line));
  const maturityDate =
    maturityIndex === -1
      ? null
      : (lines
          .slice(maturityIndex + 1, maturityIndex + 6)
          .filter((line) => MATURITY_DATE.test(line))
          .map((line) => toIsoDate(line))
          .at(-1) ?? null);

  return {
    from: opening.date,
    to: closing.date,
    openingBalance: opening.amount,
    closingBalance: closing.amount,
    rows,
    problems,
    maturityDate,
  };
};

type StatementCheck = {
  readonly ok: boolean;
  readonly expectedEur: bigint;
  readonly actualEur: bigint;
  readonly differenceEur: bigint;
};

export const verifyStatement = (statement: PdfStatement): StatementCheck => {
  const movement = statement.rows.reduce((sum, row) => sum + row.amount, 0n);
  const actual = statement.openingBalance.minor + movement;
  const expected = statement.closingBalance.minor;
  return {
    ok: actual === expected,
    expectedEur: expected,
    actualEur: actual,
    differenceEur: expected - actual,
  };
};
