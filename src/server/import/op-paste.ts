import { EUR, parseMoney, parseQuantity } from "../../core/money.ts";
import { normaliseDate } from "./map.ts";
import type { CsvProblem, RawRow } from "./types.ts";

/**
 * OP's web transaction view has no export button; the only way to get
 * transactions out of it is to select the table and paste. A browser copy
 * of an HTML table yields **one value per line, with no delimiter at
 * all** -- not the tab- or semicolon-separated text `parseCsv` expects.
 * Two further things break a delimiter-based parse outright, confirmed
 * against real pastes the user supplied (not guessed):
 *
 *  - **A missing fee omits the line entirely**, it does not leave an empty
 *    cell. A row is six lines (no fee) or seven (fee present), so which
 *    field is at which line position is not fixed -- reading by position
 *    would book a purchase's own total as its fee on a six-line row.
 *  - The two-line-wrapping header ("Tapahtuma-" + "päivämäärä", "Kulut /
 *    Korot /" + "Verot") means there is no single header row for
 *    `detectBroker`'s signature match to run against either.
 *
 * This file is therefore its own parser, not a `BrokerCsvConfig` fed
 * through `parseCsv` -- forcing a newline-separated, variable-length
 * format into a delimiter-shaped config is exactly the kind of "pretend
 * it fits" move that produced the original duplicate-`Valuutta` bug this
 * whole correction pass exists to fix.
 *
 * **Parse strategy: anchor on shape, not position or count.** A row block
 * (the lines between two blank/single-space separator lines) is parsed by
 * finding the one line that is shaped like a `dd.mm.yyyy` date -- the line
 * immediately before it is always the transaction type, every line before
 * that (back to the block's start) is the name, and the line immediately
 * after it is always the quantity ("N   kpl"). Everything remaining is a
 * run of currency-shaped values ("N   EUR"): the *last* of those is always
 * `Yhteensä`; if three remain, the middle one is the fee, if two remain
 * there is no fee. This survives a fee being entirely absent (a count-based
 * "row is always N lines" rule does not -- an earlier version of this
 * parser assumed exactly that and was wrong). A block whose shape doesn't
 * match any of this becomes a `CsvProblem` naming the block, never a guess
 * at which value goes where.
 *
 * **Unverified, flagged rather than assumed:**
 *  - A fund name wrapping onto more than one physical line is possible in
 *    principle (this parser handles it -- every line between the block's
 *    start and the type line is joined into the name) but has not been
 *    observed in a real paste; the user separately confirmed a visually
 *    wrapped cell still copies onto a single line, so this may never
 *    actually occur.
 *  - Whether OP's web view ever emits a transaction type beyond
 *    OSTO/MYYNTI/OSINKO in this view.
 *  - Whether a MYYNTI row ever appears without a fee (every MYYNTI example
 *    seen so far has one).
 */

/**
 * The real header block, exactly as it copies: ten physical lines for
 * eight logical columns, because "Tapahtumapäivämäärä" and "Kulut / Korot
 * / Verot" each wrap onto two lines in OP's table. Matched verbatim
 * (trimmed per line) rather than reconstructed from a wrap-detection rule,
 * since the wrapped text is a fixed, known constant, not something a
 * generic algorithm needs to infer.
 */
const HEADER_LINES = [
  "Laji",
  "Tapahtuma",
  "Tapahtuma-",
  "päivämäärä",
  "Määrä",
  "Kurssi",
  "Kulut / Korot /",
  "Verot",
  "Yhteensä",
] as const;

/**
 * A tenth header line present in some pastes and absent in others, depending on
 * how much of OP's table the selection covered. It is a column of buttons with
 * no value in any row, so it changes nothing but where the data starts --
 * requiring it rejected a perfectly good paste outright.
 */
const OPTIONAL_HEADER_LINE = "Toiminnot";

/**
 * The eight logical columns the header block above resolves to.
 * `Toiminnot` (Actions) is always empty in the real export and is not a
 * `CanonicalField` `mapRows` reads -- it is the separator itself (see the
 * module comment), never a value inside a row block, so it never appears
 * in a `RawRow.values`/`cells`.
 */
const CANONICAL_HEADERS = [
  "Laji",
  "Tapahtuma",
  "Tapahtumapäivämäärä",
  "Määrä",
  "Kurssi",
  "Kulut / Korot / Verot",
  "Yhteensä",
] as const;

const matchesHeaderBlock = (lines: readonly string[]): boolean =>
  HEADER_LINES.every((expected, index) => (lines[index] ?? "").trim() === expected);

/** How many physical lines the header occupies in this particular paste. */
const headerLineCount = (lines: readonly string[]): number =>
  (lines[HEADER_LINES.length] ?? "").trim() === OPTIONAL_HEADER_LINE
    ? HEADER_LINES.length + 1
    : HEADER_LINES.length;

const isTransactionDate = (line: string): boolean => {
  try {
    normaliseDate(line, "fi");
    return true;
  } catch {
    return false;
  }
};

const QUANTITY_LINE = /^([\s\S]+?)\s+kpl$/u;

const isShareQuantity = (line: string): boolean => {
  const match = QUANTITY_LINE.exec(line);
  const amount = match?.[1];
  if (amount === undefined) return false;
  try {
    parseQuantity(amount);
    return true;
  } catch {
    return false;
  }
};

const CURRENCY_LINE = /^([\s\S]+?)\s+([A-ZÅÄÖ]{3})$/u;

const isCurrencyAmount = (line: string): boolean => {
  const match = CURRENCY_LINE.exec(line);
  const amount = match?.[1];
  if (amount === undefined) return false;
  try {
    // The currency argument is irrelevant to whether the numeric part
    // parses; only the numeric shape is being validated here.
    parseMoney(amount, EUR);
    return true;
  } catch {
    return false;
  }
};

type BlockResult =
  | { readonly kind: "row"; readonly row: RawRow }
  | { readonly kind: "problem"; readonly problem: CsvProblem };

const rowResult = (row: RawRow): BlockResult => ({ kind: "row", row });
const problemResult = (
  line: number,
  message: string,
  blockLines: readonly string[],
): BlockResult => ({ kind: "problem", problem: { line, message, raw: blockLines.join("\n") } });

/**
 * Parses one row block (the lines between two separators) by shape, per
 * the module comment's strategy. Never recomputes or cross-checks
 * `Yhteensä` against quantity × price: OP's displayed `Kurssi` is rounded
 * for display, so `quantity * Kurssi` does not reconcile with the real
 * `Yhteensä` on most real sell rows (confirmed against real MYYNTI rows: the
 * two disagree by a few cents, because the displayed unit price has already been
 * rounded) -- `Yhteensä` is authoritative and is never derived.
 */
const parseBlock = (lines: readonly string[], startLine: number): BlockResult => {
  const dateIndices = lines
    .map((line, index) => (isTransactionDate(line) ? index : -1))
    .filter((index) => index !== -1);

  if (dateIndices.length === 0) {
    return problemResult(startLine, "OP-rivilohkosta puuttuu päivämäärän muotoinen rivi", lines);
  }
  if (dateIndices.length > 1) {
    return problemResult(
      startLine,
      "OP-rivilohkossa on useampi kuin yksi päivämäärän muotoinen rivi",
      lines,
    );
  }
  const dateIndex = dateIndices[0]!;
  if (dateIndex === 0) {
    return problemResult(
      startLine,
      "OP-rivilohkosta puuttuu tapahtumatyyppi ennen päivämäärää",
      lines,
    );
  }

  const typeLine = lines[dateIndex - 1]!;
  const nameLines = lines.slice(0, dateIndex - 1);
  if (nameLines.length === 0) {
    return problemResult(startLine, "OP-rivilohkosta puuttuu arvopaperin nimi", lines);
  }

  const afterDate = lines.slice(dateIndex + 1);
  const quantityLine = afterDate[0];
  if (quantityLine === undefined || !isShareQuantity(quantityLine)) {
    return problemResult(
      startLine,
      "OP-rivilohkosta puuttuu määrä (kpl) päivämäärän jälkeen",
      lines,
    );
  }

  const currencyLines = afterDate.slice(1);
  // A corporate action -- a rights detachment, a share consolidation, a
  // reverse split -- moves units with no money at all, and OP renders it with
  // no currency lines whatsoever. That is a real, valid row shape, not a
  // malformed one; refusing it left a reverse split out of the ledger and the
  // position wrong by the split ratio.
  if (currencyLines.length !== 0 && currencyLines.length !== 2 && currencyLines.length !== 3) {
    return problemResult(
      startLine,
      `OP-rivilohkossa odottamaton määrä valuuttamuotoisia rivejä: ${currencyLines.length}`,
      lines,
    );
  }
  if (!currencyLines.every(isCurrencyAmount)) {
    return problemResult(startLine, "OP-rivilohkon valuuttamuotoinen rivi ei kelpaa", lines);
  }

  const total = currencyLines[currencyLines.length - 1] ?? "";
  const kurssi = currencyLines[0] ?? "";
  const kulut = currencyLines.length === 3 ? currencyLines[1]! : "";
  const name = nameLines.join(" ");
  const date = lines[dateIndex]!;

  return rowResult({
    line: startLine,
    values: {
      Laji: name,
      Tapahtuma: typeLine,
      Tapahtumapäivämäärä: date,
      Määrä: quantityLine,
      Kurssi: kurssi,
      "Kulut / Korot / Verot": kulut,
      Yhteensä: total,
    },
    cells: [name, typeLine, date, quantityLine, kurssi, kulut, total],
  });
};

/**
 * Parses OP's pasted web transaction view. Unlike `parseCsv`, this never
 * touches an `encoding`/`delimiter` -- the paste is plain UTF-8 text with
 * no separator character at all.
 */
export const parseOpPaste = (text: string) => {
  const lines = text.split(/\r?\n/);
  if (!matchesHeaderBlock(lines)) {
    throw new Error("OP-liitteen otsikkoa ei tunnistettu");
  }

  const rows: RawRow[] = [];
  const problems: CsvProblem[] = [];

  let block: string[] = [];
  let blockStartLine = 0;

  const flushBlock = (): void => {
    if (block.length === 0) return;
    const result = parseBlock(block, blockStartLine);
    if (result.kind === "row") rows.push(result.row);
    else problems.push(result.problem);
    block = [];
  };

  for (let i = headerLineCount(lines); i < lines.length; i++) {
    const raw = lines[i]!;
    const lineNumber = i + 1;
    const trimmed = raw.trim();
    if (trimmed === "") {
      flushBlock();
      continue;
    }
    if (block.length === 0) blockStartLine = lineNumber;
    block.push(trimmed);
  }
  // The final row of a real paste has no trailing separator line -- flush
  // whatever is left in `block` rather than requiring one.
  flushBlock();

  return { rows, headers: CANONICAL_HEADERS, problems };
};
