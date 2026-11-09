import { createHash } from "node:crypto";

const SAMPLE_LINES = 5;

/** Digit runs collapse to one `#` (a plain or non-breaking space between runs merges too); other separators stay so dates keep their parts. */
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
