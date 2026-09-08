import { createHash } from "node:crypto";

/** How many of the document's opening lines identify its layout. */
const SAMPLE_LINES = 5;

/**
 * A line with every run of digits collapsed to one `#`. A balance, a date
 * component, or a page marker gaining a digit next month must not change this
 * -- digit count is exactly what varies between two statements of the same
 * format, so leaving it significant would make the cache miss on every layout
 * the moment a figure crossed a power of ten.
 *
 * A plain or non-breaking space between two digit runs is a thousands
 * separator, not structure, so it merges into the same `#` -- otherwise a
 * balance crossing a thousand (a second digit group appearing) would still
 * change the shape. Every other separator (a dot, a hyphen, `(`) stays
 * significant, so a date keeps its components and two dates stay apart.
 */
const DIGIT_GROUP = /\d+(?:[ \u00A0]\d+)*/g;

export const blankDigits = (line: string): string => line.replace(DIGIT_GROUP, "#").trim();

export const fingerprint = (producer: string, lines: readonly string[]): string => {
  const sample = lines
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, SAMPLE_LINES)
    .map(blankDigits);
  return createHash("sha256")
    .update([producer, ...sample].join("\n"))
    .digest("hex");
};
