import { EUR, parseMoney, parseQuantity } from "../../core/money.ts";
import { normaliseDate } from "./map.ts";
import type { CsvProblem, RawRow } from "./types.ts";

/**
 * OP's web transaction view has no export button, and copying its table yields
 * one value per line with no delimiter at all. Two things break a delimited parse
 * outright: a missing fee omits its line rather than leaving an empty cell, so a
 * row is six lines or seven and no field sits at a fixed position; and the header
 * wraps onto two lines, so there is no single row for a signature to match.
 *
 * Hence its own parser. Blocks are read by shape, not position or count: the line
 * shaped like a date anchors the row, the type sits before it and the name before
 * that, the quantity after it, and the remaining currency-shaped values end with
 * the total -- with a fee in the middle when three remain. A block matching none
 * of this becomes a problem naming it, never a guess at which value goes where.
 *
 * Unverified rather than assumed: a name wrapping across lines is handled but has
 * never been seen, and whether the view emits other transaction types, or a sale
 * without a fee, is unknown.
 */

/**
 * The header exactly as it copies: ten physical lines for eight columns, because
 * two labels wrap. Matched verbatim rather than reconstructed by a wrap rule,
 * the text being a fixed constant.
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
 * One row block, by shape. The total is never recomputed from quantity and price:
 * the displayed unit price is already rounded, so the two disagree by cents on
 * most real sales. The printed total is authoritative.
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
