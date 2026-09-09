import type { BankRecipe } from "./types.ts";

/**
 * Round-tripped through `Date` rather than merely reformatted: extraction can
 * join fragments into something that still matches the pattern, and a stored
 * 2026-13-32 sorts wrongly everywhere.
 */
const assertReal = (iso: string, text: string): string => {
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    throw new Error(`Päivämäärää ei ole olemassa: ${JSON.stringify(text)}`);
  }
  return iso;
};

const pad = (part: number): string => String(part).padStart(2, "0");

const refuse = (text: string): never => {
  throw new Error(`Päivämäärä ei kelpaa: ${JSON.stringify(text)}`);
};

/**
 * Month names a statement may print, by the prefix that identifies them.
 * Prefixes rather than whole words: a month is spelled `Aug`, `August`,
 * `elo`, `elokuu` and `elokuuta` depending on the bank and the language, and
 * the first three or four letters separate all twelve in both.
 */
const MONTH_PREFIXES = [
  ["jan", "tammi"],
  ["feb", "helmi"],
  ["mar", "maalis"],
  ["apr", "huhti"],
  ["may", "touko"],
  ["jun", "kesä", "kesa"],
  ["jul", "heinä", "heina"],
  ["aug", "elo"],
  ["sep", "syys"],
  ["oct", "loka", "okt"],
  ["nov", "marras"],
  ["dec", "joulu"],
] as const;

/** A month part, numeric or spelled out in either language. 0 when unreadable. */
const readMonth = (part: string): number => {
  if (/^\d{1,2}$/.test(part)) return Number(part);
  const word = part.toLowerCase();
  const at = MONTH_PREFIXES.findIndex((prefixes) =>
    prefixes.some((prefix) => word.startsWith(prefix)),
  );
  // A word must be a month name and nothing more: `elokuuta` is August,
  // `elokuu-ish` is a typo, and reading it as August would invent a date.
  const known = at >= 0 && /^[\p{L}]+$/u.test(word);
  return known ? at + 1 : 0;
};

/**
 * A two-digit year, on the POSIX convention: 69-99 is the last century, 00-68
 * this one. A statement older than 1969 or later than 2068 is not a case worth
 * the ambiguity.
 */
const readYear = (part: string): number => {
  if (/^\d{4}$/.test(part)) return Number(part);
  if (!/^\d{2}$/.test(part)) return 0;
  const short = Number(part);
  return short >= 69 ? 1900 + short : 2000 + short;
};

/**
 * The three parts of a date, however the bank punctuated them. `.` `-` `/` and
 * a space all separate; a comma is dropped, so `Aug 8, 2026` reads as three
 * parts like every other shape.
 */
const partsOf = (text: string): string[] =>
  text
    .replaceAll(",", " ")
    .split(/[.\-/\s]+/)
    .filter((part) => part !== "");

/**
 * The date a statement printed, read by ORDER rather than by exact shape.
 *
 * `dateFormat` names which part comes first; the separator, the year's width
 * and a spelled-out month are read as they come. One name therefore covers a
 * family of layouts -- `8.8.2026`, `08/08/2026`, `8-8-26` and `8 Aug 2026` are
 * all day-first -- because a bank's punctuation is not a different format, and
 * enumerating every combination left real statements undescribable.
 *
 * A wrong ORDER is still wrong, and nothing here can see that `3/4/2026` was
 * meant the other way round. What catches it is the period check: a statement's
 * rows must fall between its own two dates.
 */
export const readDate = (
  text: string,
  format: BankRecipe["dateFormat"],
  yearHint?: string,
): string => {
  const trimmed = text.trim();
  const parts = partsOf(trimmed);

  // The one shape that prints no year: the statement's own period supplies it.
  if (format === "d.m.") {
    const [day, month] = parts;
    if (parts.length !== 2 || day === undefined || month === undefined) refuse(text);
    if (yearHint === undefined || !/^\d{4}$/.test(yearHint)) refuse(text);
    const readMonthPart = readMonth(month!);
    if (!/^\d{1,2}$/.test(day!) || readMonthPart === 0) refuse(text);
    return assertReal(`${yearHint!}-${pad(readMonthPart)}-${pad(Number(day))}`, text);
  }

  if (parts.length !== 3) refuse(text);
  // SAFETY: `refuse` throws, so there are exactly three parts past this line.
  const [first, second, third] = parts as [string, string, string];

  const [dayPart, monthPart, yearPart] =
    format === "yyyy-mm-dd"
      ? [third, second, first]
      : format === "m.d.yyyy"
        ? [second, first, third]
        : [first, second, third];

  const day = /^\d{1,2}$/.test(dayPart) ? Number(dayPart) : 0;
  const month = readMonth(monthPart);
  const year = readYear(yearPart);
  if (day === 0 || month === 0 || year === 0) refuse(text);

  return assertReal(`${year}-${pad(month)}-${pad(day)}`, text);
};
