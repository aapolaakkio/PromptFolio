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
export const PAGE_MAX_AGE_DAYS = 10;
/** Real Nordnet fund pages are about 1.8 MB; past this a page is not read at all. */
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
      .refine(compiles, { message: "Säännöllistä lauseketta ei voitu kääntää" })
      .refine((source) => !mayBacktrackForever(source), {
        message: "Säännöllinen lauseke voi jäädä jumiin (sisäkkäinen toisto)",
      })
      .refine((source) => !hasManyWildcards(source), {
        message: "Lauseke sisältää liian monta rajoittamatonta .*-toistoa",
      })
      .refine((source) => groupNames(source).has("price") && groupNames(source).has("date"), {
        message: "Lausekkeen on nimettävä ryhmät price ja date",
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

export type PageRead = {
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

/** The latest year that keeps day.month on or before `today`. */
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

/** Null when any group is missing or unreadable: the recipe did not read a price. */
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
  // Two matches already refuse the page, so never scan further.
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

/** The first acceptance rule the read breaks, in Finnish, or null. */
const firstFailure = (read: PageRead, expect: PageExpect): string | null => {
  const { price } = read;
  if (read.matches === 0) return "Lauseke ei löytänyt sivulta mitään.";
  if (read.matches > 1) {
    return `Lauseke osui ${read.matches} kohtaan: kohdan on löydyttävä sivulta vain kerran (useampi osuma).`;
  }
  if (price === null) return "Osuman hintaa tai päivää ei voitu lukea.";
  if (!read.identityNear) {
    return `Osuman lähellä (${IDENTITY_WINDOW_CHARS} merkin sisällä) ei ole tunnistetta ${expect.identity}.`;
  }
  if (price.currency !== expect.currency) {
    return `Luettu valuutta ${price.currency} ei vastaa rahaston valuuttaa ${expect.currency}.`;
  }
  const age = daysBetween(price.date, expect.today);
  if (age < 0) return `Päivä ${price.date} on tulevaisuudessa.`;
  if (age > PAGE_MAX_AGE_DAYS) {
    return `Päivä ${price.date} on liian vanha (yli ${PAGE_MAX_AGE_DAYS} päivää).`;
  }
  // ponytail: skipped when no reference exists, e.g. on the first read of a new fund.
  if (expect.referenceMinor !== null && !isPlausibleMove(expect.referenceMinor, price.closeMinor)) {
    return `Hinta ${price.closeMinor} on kohtuuton viitehintaan ${expect.referenceMinor} nähden.`;
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
