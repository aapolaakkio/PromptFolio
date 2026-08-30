import { EUR, parseMoney, type Money } from "../../core/money.ts";
import type { IsoDate } from "../../core/types.ts";
import type { BankRow } from "./bank-statement.ts";

/**
 * OP's PDF statement, which carries what the CSV does not: the balances at each
 * end of the period. Those make the import self-checking -- opening plus every
 * parsed row must equal the printed closing, and a mis-parse cannot pass
 * silently because mangled rows do not add up to a number the bank printed.
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
 * `29.8.2025` as OP prints it, to ISO. Checked against the calendar, not merely
 * reformatted: extraction can join two fragments into something that still
 * matches the pattern, and a stored 2026-13-32 sorts wrongly everywhere.
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
  /^(Tilinumero|BIC|Kirjaus-|päivä|Arvopäivä|Määrä,|euroa|Selitys|Maksunsaaja\/maksaja|Viesti$|Viite|Saajan|Tiliote|Käyttötili|Määräaikainen|Eräpäivä|Ajalta|Asiakkaan tulostama|Jatkuu|\d+ \(\d+\)$)/;

/** A bank identifier code, as the header prints under "BIC". */
const BIC_LINE = /^[A-Z]{6}[A-Z0-9]{2,5}$/;

/** An IBAN with the spacing OP prints: `FI00 0000 0000 0000 00`. */
const IBAN_LINE = /^[A-Z]{2}\d{2}(\s\d{4})+(\s\d{1,4})?$/;
const IBAN_INSIDE = /[A-Z]{2}\d{2}(\s\d{4})+(\s\d{1,4})?/;

/**
 * The period the statement covers, repeated on every page. It sits where a row
 * continued across a page break looks for its counterparty, so seventeen real
 * payments were filed under a date range as though it were a shop.
 */
const PERIOD_LINE = new RegExp(`^${DATE}\\s*-\\s*${DATE}$`);

/**
 * Card-terminal noise printed under "Viesti:" on a card payment: the masked
 * card number, the terminal's own reference, the authorisation code. None of it
 * says anything about what was bought, and putting it in the note would bury
 * the payee it sits next to.
 */
const TERMINAL_NOISE = /^(\d{6}\*+\d{4}|MF NRO|VARMENTAJA|OSTOPVM)/;

/** `Eräpäivä 1.2.2027`, on the statement of a fixed-term deposit. */
const MATURITY = new RegExp(`^Eräpäivä$`);

/**
 * The bank's archive id, sitting before the line's trailing flag. A row may also
 * carry a payment reference, which is deliberately not used: two payments of the
 * same rent share one, and as an identity it would swallow the second.
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
 * The leading run of words before the references and ids. Taking one token
 * truncated every multi-word label, so credit repayments sat unclassified while
 * a rule for them existed.
 */
const labelOf = (tail: string): string => {
  const words: string[] = [];
  for (const token of tail.trim().split(/\s+/)) {
    // A word is letters, with the dots and hyphens OP puts in "TALLETUSAUTOM."
    // and "PÄÄOMIT YLIT.KORKO". Anything with a digit is a reference.
    if (!/^[A-ZÄÖÅ][A-ZÄÖÅ.-]*$/.test(token)) break;
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

  /**
   * The account this statement is for, recognised so it is not read as a payee:
   * a row continued across a page break has the repeated header between it and
   * its counterparty. Only this number is furniture -- an IBAN elsewhere is a
   * real payee whose name the bank did not print.
   */
  const ownAccount = ((): string => {
    const labelled = lines.findIndex((line) => line.startsWith("Tilinumero"));
    if (labelled === -1) return "";
    // Either "Tilinumero FI00 ..." on one line, or the label with the number a
    // few lines below it, depending on how the page's header wrapped.
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

      // The first line after the header that is neither furniture nor the
      // message block. Scanned as far as the next transaction, not a fixed few
      // lines: a page break puts the whole header in between.
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

      // What the payer wrote, when they wrote anything: a rent payment says so
      // there, and it is often the only thing that identifies the payment at
      // all when the payee is a person or a housing company's account number.
      const messageAt = usable.findIndex((candidate) => candidate.startsWith("Viesti:"));
      const message =
        messageAt === -1
          ? ""
          : (usable.slice(messageAt + 1).find((candidate) => candidate !== counterparty) ?? "");

      rows.push({
        line: index + 1,
        date: toIsoDate(dateText),
        type: rowType(label, amount),
        amount,
        counterparty,
        note: [label, counterparty, message].filter((part) => part !== "").join(" — "),
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
 * Whether the parsed rows account for the balance the statement prints. The check
 * the whole PDF path rests on: a missed row, a doubled one or a split amount all
 * change the sum, and the difference is reported rather than written as fact.
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
