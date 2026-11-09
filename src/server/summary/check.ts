import { isUnsignedNumberIn, numberTokensIn } from "../import/suggest-rows.ts";

export const MAX_WORDS = 120;

const NUMBER_WORDS = new RegExp(
  `\\b(?:${[
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
    "twenty",
  ].join("|")})\\b`,
  "i",
);
const ADVICE = /\b(?:buy|sell|should)\b/i;

/** `factsText` is the exact JSON the model was shown. Every number printed must be one whole number of it; words for numbers and advice are rejected because digits are all that is checked. */
export const isCheckedSummary = (text: string, factsText: string): boolean => {
  const words = text.trim().split(/\s+/);
  if (text.trim() === "" || words.length > MAX_WORDS) return false;
  if (NUMBER_WORDS.test(text) || ADVICE.test(text)) return false;
  return numberTokensIn(text).every((token) => isUnsignedNumberIn(token, factsText));
};
