import { isUnsignedNumberIn, numberTokensIn } from "../import/suggest-rows.ts";

export const MAX_WORDS = 120;

const wordsOf = (words: readonly string[]): RegExp =>
  new RegExp(`\\b(?:${words.join("|")})\\b`, "i");

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

const SENTENCES = /(?<=[.!?])\s+|\n/;

const positionsOf = (pattern: RegExp, sentence: string): number[] =>
  [...sentence.matchAll(new RegExp(pattern.source, "gi"))].map((match) => match.index);

const occurrencesOf = (token: string, sentence: string): number[] => {
  const found: number[] = [];
  for (let at = sentence.indexOf(token); at !== -1; at = sentence.indexOf(token, at + 1)) {
    found.push(at);
  }
  return found;
};

/**
 * The direction word nearest to a figure decides how the sentence describes it, so one sentence may say one figure rose and another fell.
 * Fails closed: a change printed with no direction word, or with both kinds equally near, is refused, since a bare "100.00" for a fall reads as a gain.
 */
const wrongDirection = (text: string, factsText: string): string | null => {
  const figures = directionalFigures(factsText);
  for (const sentence of text.split(SENTENCES)) {
    const ups = positionsOf(UP_WORDS, sentence);
    const downs = positionsOf(DOWN_WORDS, sentence);
    for (const token of numberTokensIn(sentence, true)) {
      const figure = figures.find((candidate) => isUnsignedNumberIn(token, candidate.value));
      if (figure === undefined) continue;
      const went = `${token} went ${figure.up ? "up" : "down"}`;
      for (const at of occurrencesOf(token, sentence)) {
        const nearest = (positions: readonly number[]): number =>
          Math.min(
            ...positions.map((position) => Math.abs(position - at)),
            Number.POSITIVE_INFINITY,
          );
        const up = nearest(ups);
        const down = nearest(downs);
        if (up === down) return `${went}; say so with "up" or "down" right next to it`;
        if (up < down !== figure.up) return went;
      }
    }
  }
  return null;
};

/** `rule` is a fixed label safe to log; `message` is for the model and may quote its own text. */
export type SummaryProblem = {
  readonly rule: "empty" | "length" | "invented-number" | "direction";
  readonly message: string;
};

/**
 * What is wrong with a note, or null when it passes. `factsText` is the exact JSON the model was shown.
 * Two things are checked, the two a reader would be misled by: every number printed must be one whole number of the facts, and a change must be described in its own direction. Wording is otherwise the model's own (the owner wants no topic off limits).
 */
export const summaryProblem = (raw: string, factsText: string): SummaryProblem | null => {
  const text = raw.normalize("NFKC");
  if (text.trim() === "") return { rule: "empty", message: "The note is empty." };
  if (text.trim().split(/\s+/).length > MAX_WORDS) {
    return { rule: "length", message: `Too long: at most ${MAX_WORDS} words.` };
  }
  const invented = numberTokensIn(text, true).find(
    (token) => !isUnsignedNumberIn(token, factsText),
  );
  if (invented !== undefined) {
    return {
      rule: "invented-number",
      message: `The number ${invented} is not in the facts: copy every number exactly, and never calculate or round.`,
    };
  }
  const direction = wrongDirection(text, factsText);
  return direction === null
    ? null
    : { rule: "direction", message: `Wrong or missing direction: ${direction}.` };
};

export const isCheckedSummary = (raw: string, factsText: string): boolean =>
  summaryProblem(raw, factsText) === null;
