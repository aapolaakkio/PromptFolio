import { z } from "zod";

import { parseCurrency, parseMoney, type Currency } from "../../core/money.ts";
import { readDate } from "../import/recipe/date-format.ts";
import type { Judged } from "../import/recipe/ask.ts";
import { readDecimal } from "../import/recipe/money-format.ts";
import { hasManyWildcards, mayBacktrackForever } from "../import/recipe/pattern-safety.ts";
import { MAX_PATTERN_LENGTH, MoneyFormatSchema } from "../import/recipe/types.ts";
import type { FetchedPrice } from "./types.ts";
import { isPlausibleMove } from "./write.ts";

export const IDENTITY_WINDOW_CHARS = 5_000;
const PAGE_MAX_AGE_DAYS = 10;
export const MAX_PAGE_CHARS = 3_000_000;

const DAY_MS = 24 * 60 * 60 * 1000;

const groupNames = (source: string): ReadonlySet<string> =>
  new Set([...source.matchAll(/\(\?<([A-Za-z][A-Za-z0-9]*)>/g)].map((m) => m[1] ?? ""));

const compiles = (source: string): boolean => {
  try {
    new RegExp(source, "u");
    return true;
  } catch {
    return false;
  }
};

export const PageRecipeSchema = z
  .object({
    kind: z.literal("page"),
    pattern: z
      .string()
      .min(1)
      .max(MAX_PATTERN_LENGTH)
      .refine(compiles, { message: "The regular expression could not be compiled" })
      .refine((source) => !mayBacktrackForever(source), {
        message: "The regular expression can hang (nested repetition)",
      })
      .refine((source) => !hasManyWildcards(source), {
        message: "The expression contains too many unbounded .* repetitions",
      })
      .refine((source) => groupNames(source).has("price") && groupNames(source).has("date"), {
        message: "The expression must name the groups price and date",
      }),
    dateFormat: z.enum(["d.m.yyyy", "dd.mm.yyyy", "yyyy-mm-dd", "d.m.", "dd.mm."]),
    money: MoneyFormatSchema,
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
  })
  .strict();

export type PageRecipe = z.infer<typeof PageRecipeSchema>;

type PageRead = {
  readonly matches: number;
  readonly price: FetchedPrice | null;
  readonly identityNear: boolean;
};

export type PageExpect = {
  readonly identity: string;
  readonly currency: Currency;
  readonly referenceMinor: number | null;
  readonly today: string;
};

const yearFor = (dayMonth: string, today: string): string => {
  const thisYear = Number(today.slice(0, 4));
  const [day = "", month = ""] = dayMonth.split(".");
  const candidate = `${thisYear}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return String(candidate > today ? thisYear - 1 : thisYear);
};

const dateOf = (text: string, recipe: PageRecipe, today: string): string => {
  if (recipe.dateFormat === "d.m." || recipe.dateFormat === "dd.mm.") {
    return readDate(text, "d.m.", yearFor(text.trim(), today));
  }
  return readDate(text, recipe.dateFormat === "yyyy-mm-dd" ? "yyyy-mm-dd" : "d.m.yyyy");
};

const priceOf = (
  groups: Record<string, string | undefined>,
  recipe: PageRecipe,
  today: string,
): FetchedPrice | null => {
  const { price, date } = groups;
  const code = groups["currency"] ?? recipe.currency;
  if (price === undefined || date === undefined || code === null || code === undefined) return null;
  try {
    const currency = parseCurrency(code);
    const minor = Number(parseMoney(readDecimal(price, recipe.money), currency).minor);
    if (!Number.isSafeInteger(minor) || minor <= 0) return null;
    return { date: dateOf(date, recipe, today), closeMinor: minor, currency };
  } catch {
    return null;
  }
};

export const runPageRecipe = (
  html: string,
  recipe: PageRecipe,
  identity: string,
  today: string,
): PageRead => {
  const none: PageRead = { matches: 0, price: null, identityNear: false };
  if (html.length > MAX_PAGE_CHARS) return none;

  // ponytail: V8 regex is not time-boxed; a stuck run ends only at the Workers CPU limit. Move to RE2/wasm if this ever bites.
  const regex = new RegExp(recipe.pattern, "gu");
  const first = regex.exec(html);
  if (first === null) return none;
  let matches = 1;
  const second = regex.exec(html);
  if (second !== null) matches = 2;

  const start = first.index;
  const near = html.slice(
    Math.max(0, start - IDENTITY_WINDOW_CHARS),
    start + first[0].length + IDENTITY_WINDOW_CHARS,
  );
  return {
    matches,
    price: priceOf(first.groups ?? {}, recipe, today),
    identityNear: near.toLowerCase().includes(identity.toLowerCase()),
  };
};

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

const firstFailure = (read: PageRead, expect: PageExpect): string | null => {
  const { price } = read;
  if (read.matches === 0) return "The expression matched nothing on the page.";
  if (read.matches > 1) {
    return `The expression matched ${read.matches} places: it must match exactly one place on the page (several matches).`;
  }
  if (price === null) return "The price or date of the match could not be read.";
  if (!read.identityNear) {
    return `The identifier ${expect.identity} is not near the match (within ${IDENTITY_WINDOW_CHARS} characters).`;
  }
  if (price.currency !== expect.currency) {
    return `The currency read, ${price.currency}, does not match the fund's currency ${expect.currency}.`;
  }
  const age = daysBetween(price.date, expect.today);
  if (age < 0) return `The date ${price.date} is in the future.`;
  if (age > PAGE_MAX_AGE_DAYS) {
    return `The date ${price.date} is too old (over ${PAGE_MAX_AGE_DAYS} days).`;
  }
  // ponytail: skipped when no reference exists, e.g. on the first read of a new fund.
  if (expect.referenceMinor !== null && !isPlausibleMove(expect.referenceMinor, price.closeMinor)) {
    return `The price ${price.closeMinor} is unreasonable against the reference price ${expect.referenceMinor}.`;
  }
  return null;
};

export const judgePageRead = (read: PageRead, expect: PageExpect): Judged => {
  const failure = firstFailure(read, expect);
  return {
    passed: failure === null,
    score: read.matches === 1 && read.price !== null ? 1 : 0,
    feedback: failure ?? "",
  };
};
