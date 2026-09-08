import { createHash } from "node:crypto";

/** How many of the document's opening lines identify its layout. */
const SAMPLE_LINES = 5;

/**
 * A line with every run of digits collapsed to one `#`. A balance, a date
 * component, or a page marker gaining a digit next month must not change this
 * -- digit count is exactly what varies between two statements of the same
 * format, so leaving it significant would make the cache miss on every layout
 * the moment a figure crossed a power of ten.
 */
export const blankDigits = (line: string): string => line.replace(/\d+/g, "#").trim();

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
