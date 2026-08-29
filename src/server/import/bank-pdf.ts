import { EUR, parseMoney, type Money } from "../../core/money";
import type { IsoDate } from "../../core/types";
import type { BankRow } from "./bank-statement";

/**
 * OP's PDF statement, which carries what the CSV export does not: the balance
 * at the start of the period and the balance at the end.
 *
 * Those two make the import self-checking. Opening balance plus every parsed row
 * must equal the printed closing balance; when it does not, the parse is wrong
 * and the import is refused rather than written. A PDF's layout is a far more
 * fragile thing to read than a CSV's columns, and this is what makes reading it
 * acceptable anyway: a mis-parse cannot pass silently, because mangled rows do
 * not add up to a number the bank printed.
 */
export type PdfStatement = {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly openingBalance: Money;
  readonly closingBalance: Money;
  readonly rows: BankRow[];
  readonly problems: Array<{ line: number; message: string }>;
  /**
   * When a fixed-term deposit comes free, as the statement prints it
   * (`Eräpäivä 1.2.2027`). Null on every other kind of statement. Reported to
   * the caller rather than written to the account: changing an account's terms
   * as a side effect of reading a file is not something an owner asked for.
   */
  readonly maturityDate: IsoDate | null;
};

/**
 * A minus sign as OP prints it (U+2212), and a non-breaking space as the
 * thousands separator. Neither is what `parseMoney` expects, and neither is
 * what anyone types, so both are normalised before parsing rather than being
 * special-cased at every comparison.
 */
const normaliseAmount = (text: string): string =>
  text
    .replace(/−/g, "-")
    .replace(/[\s\u00a0]/g, "")
    // A leading "+" is how the statement marks money in; `parseMoney` takes a
    // bare number or a minus sign, so it is dropped rather than passed through.
    .replace(/^\+/, "")
    .replace(",", ".");

/**
 * `29.8.2025` as OP prints it, to `2025-08-29`.
 *
 * The result is checked back against the calendar rather than merely
 * reformatted: text extraction can join two fragments into something that still
 * matches the date pattern, and "2026-13-32" stored as a trade date would sort
 * and filter wrongly everywhere downstream without ever looking malformed.
 */
const toIsoDate = (text: string): IsoDate => {
  const [day, month, year] = text.split(".");
  if (day === undefined || month === undefined || year === undefined) {
    throw new Error(`Päivämäärää ei voitu lukea: "${text}"`);
  }
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    throw new Error(`Päivämäärää ei ole olemassa: "${text}"`);
  }
  return iso;
};

const DATE = String.raw`\d{1,2}\.\d{1,2}\.\d{4}`;
/**
 * The sign is optional: a current account's statement prints a signed balance, while a
 * fixed-term deposit opens with a bare `0,00`. Requiring it meant neither
 * balance line on a deposit statement matched, and a real OP statement was
 * refused as "not an OP statement".
 */
const AMOUNT = String.raw`[+−-]?\d{1,3}(?:[  ]\d{3})*,\d{2}`;

/** A transaction's first line: date, amount, then the label and its trailing ids. */
const HEADER = new RegExp(`^(${DATE})\\s+(${AMOUNT})\\s+(.*)$`);

/** `+1 500,00 Saldo 28.8.2026` -- the period's opening and closing balances. */
const BALANCE = new RegExp(`^(${AMOUNT})\\s+Saldo\\s+(${DATE})$`);

/**
 * Page furniture: column headings, the account's own identifiers, and the page
 * number. Skipped when looking for a row's counterparty, which is otherwise
 * simply "the next line".
 */
const FURNITURE =
  /^(Tilinumero|BIC|Kirjaus-|päivä|Arvopäivä|Määrä,|euroa|Selitys|Maksunsaaja\/maksaja|Viesti$|Viite|Saajan|Tiliote|Käyttötili|Määräaikainen|Eräpäivä|Ajalta|Asiakkaan tulostama|\d+ \(\d+\)$)/;

/**
 * The period the statement covers, printed under "Ajalta" and repeated on every
 * page: `29.8.2025 - 28.8.2026`.
 *
 * It sits directly below a page's repeated header, which is exactly where a row
 * continued across the page break looks for its counterparty -- so seventeen
 * payments in a real statement were filed under a date range as though it were
 * a shop.
 */
const PERIOD_LINE = new RegExp(`^${DATE}\\s*-\\s*${DATE}$`);

/** `Eräpäivä 1.2.2027`, on the statement of a fixed-term deposit. */
const MATURITY = new RegExp(`^Eräpäivä$`);

/**
 * The bank's archive id for a row.
 *
 * The line ends with a single-letter flag, before which sits the archive id --
 * twenty characters, digits with an occasional letter run (`...EQEO...`,
 * `...UTZ...`). A row may also carry a payment reference before that, which is
 * not unique and is deliberately not used: two payments of the same rent carry
 * the same reference, and treating it as an identity would make the second one
 * vanish as a duplicate.
 */
const ARCHIVE_ID = /^[0-9A-Z]{16,}$/;

const archiveIdOf = (tail: string, following: readonly string[]): string | null => {
  const tokens = tail.trim().split(/\s+/);
  const withoutFlag =
    tokens.length > 1 && /^[A-Z]$/.test(tokens.at(-1) ?? "") ? tokens.slice(0, -1) : tokens;
  const onHeader = withoutFlag.at(-1) ?? "";
  if (ARCHIVE_ID.test(onHeader)) return onHeader;

  // A fixed-term deposit's statement puts the id below the row instead, after
  // the message. Searched rather than taken from a fixed position, since the
  // lines between vary with how much the payer wrote.
  return following.find((line) => ARCHIVE_ID.test(line)) ?? null;
};

/**
 * The label, which is the leading run of words before the references and ids.
 *
 * Taking only the first token truncated every label a bank writes as more than
 * one word: "LUOTON MAKSU" became "LUOTON", and no rule written against the
 * real label matched it -- so credit repayments sat unclassified while a rule
 * for them existed.
 */
const labelOf = (tail: string): string => {
  const words: string[] = [];
  for (const token of tail.trim().split(/\s+/)) {
    // A word is letters, with the dots and hyphens OP puts in "TALLETUSAUTOM."
    // and "PÄÄOMIT YLIT.KORKO". Anything with a digit is a reference.
    if (!/^[A-ZÄÖÅ][A-ZÄÖÅ.\-]*$/.test(token)) break;
    words.push(token);
  }
  return words.join(" ");
};

const INTEREST_LABELS = ["TALLETUSKORKO", "KORKO"];

const rowType = (label: string, amount: bigint): BankRow["type"] => {
  if (amount > 0n && INTEREST_LABELS.some((known) => label.toUpperCase().includes(known))) {
    return "INTEREST";
  }
  return amount < 0n ? "WITHDRAWAL" : "DEPOSIT";
};

/**
 * Reads OP's PDF statement from already-extracted text.
 *
 * Kept separate from the extraction itself so the parsing rules can be tested
 * against text fixtures, with no PDF and no library in the way -- the layout is
 * what changes between statements, not the bytes around it.
 */
export const parseOpStatementText = (text: string): PdfStatement => {
  const lines = text.split("\n").map((line) => line.trim());
  const problems: Array<{ line: number; message: string }> = [];

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
      "Tiliotteesta ei löytynyt alku- ja loppusaldoa; tarkista että tiedosto on OP:n tiliote",
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

      // The counterparty is the first line after the header that is not the
      // statement's own furniture and not the start of the message block. A row
      // with none (interest, a cash deposit) simply has no counterparty.
      //
      // Scanned as far as the next transaction rather than a fixed few lines: a
      // row broken across a page break has the whole repeated header between it
      // and its counterparty, and a window that stopped short took the period
      // line instead.
      const following: string[] = [];
      for (let ahead = index + 1; ahead < lines.length; ahead++) {
        const candidate = lines[ahead] ?? "";
        if (HEADER.test(candidate) || BALANCE.test(candidate)) break;
        following.push(candidate);
      }
      const counterparty =
        following.find(
          (candidate) =>
            candidate !== "" &&
            !FURNITURE.test(candidate) &&
            !PERIOD_LINE.test(candidate) &&
            !candidate.startsWith("Viesti:"),
        ) ?? "";

      rows.push({
        line: index + 1,
        date: toIsoDate(dateText),
        type: rowType(label, amount),
        amount,
        counterparty,
        note: [label, counterparty].filter((part) => part !== "").join(" — "),
        externalId: archiveIdOf(tail, following),
      });
    } catch (cause) {
      problems.push({
        line: index + 1,
        message: cause instanceof Error ? cause.message : "Rivin käsittely epäonnistui",
      });
    }
  }

  const maturityIndex = lines.findIndex((line) => MATURITY.test(line));
  const maturityDate =
    maturityIndex === -1
      ? null
      : (lines
          .slice(maturityIndex + 1, maturityIndex + 6)
          .filter((line) => new RegExp(`^${DATE}$`).test(line))
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

/**
 * Whether the parsed rows account for the balance the statement itself prints.
 *
 * This is the check the whole PDF path rests on. A layout the parser reads
 * wrongly -- a missed row, a doubled one, an amount split across two lines --
 * changes the sum, and the difference is reported instead of being written to
 * the ledger as fact.
 */
export type StatementCheck = {
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

/**
 * Extracts a PDF's text. Split out so every other function here stays pure and
 * testable, and so a scanned statement -- an image with no text layer at all --
 * is reported as such rather than parsed into nothing.
 */
export const extractStatementText = async (bytes: ArrayBuffer): Promise<string> => {
  const { extractText, getDocumentProxy } = await import("unpdf");
  // pdf.js takes ownership of the array it is given and detaches the underlying
  // buffer, so a copy goes in. Without it the caller's own bytes become
  // unusable -- the route hashes the same file afterwards, and got
  // "Buffer is already detached" instead.
  const pdf = await getDocumentProxy(new Uint8Array(bytes.slice(0)));
  const { text } = await extractText(pdf, { mergePages: true });
  if (text.trim() === "") {
    throw new Error("PDF ei sisällä tekstiä (skannattu kuva?); tuo tapahtumat CSV-muodossa");
  }
  return text;
};
