import { isUnsignedNumberIn, numberTokensIn } from "../import/suggest-rows.ts";

export const MAX_WORDS = 120;

const wordsOf = (words: readonly string[]): RegExp =>
  new RegExp(`\\b(?:${words.join("|")})\\b`, "i");

const NUMBER_WORDS = wordsOf([
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
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
  "hundred",
  "thousand",
  "million",
  "billion",
  "half",
  "twice",
  "double",
  "triple",
  "dozen",
  "couple",
]);
const ADVICE = wordsOf([
  "buy\\w*",
  "bought",
  "sell\\w*",
  "sold",
  "should",
  "shouldn't",
  "consider\\w*",
  "trim\\w*",
  "reduce",
  "reducing",
  "rebalanc\\w*",
  "recommend\\w*",
  "must",
  "ought",
  "add(?:ing)? to",
  "increas\\w* (?:your|the) (?:position|holding|stake)",
]);
const FULL_DATE = /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./]\d{1,2}[./]\d{2,4}/;
const UP_WORDS = wordsOf([
  "up",
  "rose",
  "risen",
  "gain\\w*",
  "higher",
  "increas\\w*",
  "grew",
  "grow\\w*",
  "climb\\w*",
]);
const DOWN_WORDS = wordsOf([
  "down",
  "fell",
  "fall\\w*",
  "lost",
  "loss\\w*",
  "lower",
  "decreas\\w*",
  "drop\\w*",
  "declin\\w*",
  "dip\\w*",
]);

type Figure = { readonly key: string; readonly value: string };

/** Every numeric value of the pretty-printed facts with its key, one per line. */
const figuresOf = (factsText: string): Figure[] =>
  [...factsText.matchAll(/"(\w+)": "?(-?\d+(?:\.\d+)?)"?,?$/gm)].map((match) => ({
    key: match[1] ?? "",
    value: match[2] ?? "",
  }));

/** A figure under a "change…" key has a direction; other figures (totals, deposits) are described without one. */
const directionalFigures = (factsText: string): { value: string; up: boolean }[] => {
  const figures = figuresOf(factsText);
  const plain = figures.filter((figure) => !figure.key.startsWith("change"));
  return figures
    .filter((figure) => figure.key.startsWith("change") && Number(figure.value) !== 0)
    .filter((figure) => !plain.some((other) => isUnsignedNumberIn(figure.value, other.value)))
    .map((figure) => ({ value: figure.value.replace(/^-/, ""), up: Number(figure.value) > 0 }));
};

const contradictsDirection = (text: string, factsText: string): boolean => {
  const figures = directionalFigures(factsText);
  return text.split(/(?<=[.!?])\s+|\n/).some((sentence) => {
    const tokens = numberTokensIn(sentence, true);
    return figures.some((figure) => {
      if (!tokens.some((token) => isUnsignedNumberIn(token, figure.value))) return false;
      return figure.up
        ? DOWN_WORDS.test(sentence) || !UP_WORDS.test(sentence)
        : UP_WORDS.test(sentence) || !DOWN_WORDS.test(sentence);
    });
  });
};

/** `factsText` is the exact JSON the model was shown. Every number printed must be one whole number of it, and a change must be described in its own direction; words for numbers, dates and advice are rejected because digits are all that is checked. */
export const isCheckedSummary = (raw: string, factsText: string): boolean => {
  const text = raw.normalize("NFKC");
  if (text.trim() === "" || text.trim().split(/\s+/).length > MAX_WORDS) return false;
  if (NUMBER_WORDS.test(text) || ADVICE.test(text) || FULL_DATE.test(text)) return false;
  return (
    numberTokensIn(text, true).every((token) => isUnsignedNumberIn(token, factsText)) &&
    !contradictsDirection(text, factsText)
  );
};
