import type { BankRecipe } from "./types.ts";

/** Round-tripped through Date: fragments can match the pattern yet form 2026-13-32. */
export const assertReal = (iso: string, text: string): string => {
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    throw new Error(`The date does not exist: ${JSON.stringify(text)}`);
  }
  return iso;
};

const pad = (part: number): string => String(part).padStart(2, "0");

const refuse = (text: string): never => {
  throw new Error(`Invalid date: ${JSON.stringify(text)}`);
};

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

const readMonth = (part: string): number => {
  if (/^\d{1,2}$/.test(part)) return Number(part);
  const word = part.toLowerCase();
  const at = MONTH_PREFIXES.findIndex((prefixes) =>
    prefixes.some((prefix) => word.startsWith(prefix)),
  );
  // A word must be exactly a month name: `elokuuta` is August, `elokuu-ish` is a typo and must not invent a date.
  const known = at >= 0 && /^[\p{L}]+$/u.test(word);
  return known ? at + 1 : 0;
};

const readYear = (part: string): number => {
  if (/^\d{4}$/.test(part)) return Number(part);
  if (!/^\d{2}$/.test(part)) return 0;
  const short = Number(part);
  return short >= 69 ? 1900 + short : 2000 + short;
};

const partsOf = (text: string): string[] =>
  text
    .replaceAll(",", " ")
    .split(/[.\-/\s]+/)
    .filter((part) => part !== "");

/** Read by ORDER: `dateFormat` names which part comes first. A wrong order is caught only by the period check. */
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
