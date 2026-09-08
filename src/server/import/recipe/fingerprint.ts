import { createHash } from "node:crypto";

/** How many of the document's opening lines identify its layout. */
const SAMPLE_LINES = 5;

/**
 * A dotted number -- a day, month or year in a `d.m.yyyy`-style date -- blanks
 * as one `#` per component, so a one-digit day and a two-digit day shape the
 * same. A digit run with no dot touching it (an account number, an amount)
 * blanks one `#` per digit instead, since there the digit count is the layout.
 */
const DOTTED_RUN = /\d+(?=\.)|(?<=\.)\d+/g;

/**
 * A line with its figures blanked. Next month's statement prints a different
 * period and different balances in the same places, so hashing the raw lines
 * would make every statement a new format and the cache would never hit.
 */
// eslint-disable-next-line anti-slop/no-shape-in-symbol-names -- the term is the domain concept: a line's digit-blanked layout.
export const shape = (line: string): string =>
  line.replace(DOTTED_RUN, "#").replace(/\d/g, "#").trim();

export const fingerprint = (producer: string, lines: readonly string[]): string => {
  const sample = lines
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, SAMPLE_LINES)
    // eslint-disable-next-line anti-slop/no-shape-in-symbol-names -- see the export above.
    .map(shape);
  return createHash("sha256")
    .update([producer, ...sample].join("\n"))
    .digest("hex");
};
