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

const pad = (part: string): string => part.padStart(2, "0");

export const readDate = (
  text: string,
  format: BankRecipe["dateFormat"],
  yearHint?: string,
): string => {
  const trimmed = text.trim();
  if (format === "yyyy-mm-dd") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (!match) throw new Error(`Päivämäärä ei kelpaa: ${JSON.stringify(text)}`);
    return assertReal(trimmed, text);
  }
  if (format === "d.m.") {
    const match = /^(\d{1,2})\.(\d{1,2})\.$/.exec(trimmed);
    if (!match || yearHint === undefined || !/^\d{4}$/.test(yearHint)) {
      throw new Error(`Päivämäärä ei kelpaa: ${JSON.stringify(text)}`);
    }
    return assertReal(`${yearHint}-${pad(match[2]!)}-${pad(match[1]!)}`, text);
  }
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(trimmed);
  if (!match) throw new Error(`Päivämäärä ei kelpaa: ${JSON.stringify(text)}`);
  return assertReal(`${match[3]!}-${pad(match[2]!)}-${pad(match[1]!)}`, text);
};
