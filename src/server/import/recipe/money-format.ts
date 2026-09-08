import { EUR, parseMoney } from "../../../core/money.ts";
import type { MoneyFormat } from "./types.ts";

const UNREADABLE = (text: string): Error =>
  new Error(`Summaa ei voitu lukea: ${JSON.stringify(text)}`);

/**
 * U+2212 is a minus sign that is not the hyphen any parser expects. Normalised
 * for every format: this is a character-identity fix, not a formatting choice
 * the model gets to describe.
 */
const MINUS = /−/g;

const escapeForClass = (text: string): string => text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

/**
 * `strip` entries are currency codes and symbols, printed only at the ends of
 * a figure. Removing them anywhere in the string (e.g. a naive `split/join`)
 * can eat digits that happen to match. Only a prefix or a suffix of the
 * trimmed body is removed, repeated until neither end matches any entry.
 */
const stripEnds = (text: string, words: readonly string[]): string => {
  let body = text.trim();
  let changed = words.length > 0;
  while (changed) {
    changed = false;
    for (const word of words) {
      if (body.startsWith(word)) {
        body = body.slice(word.length).trim();
        changed = true;
      } else if (body.endsWith(word)) {
        body = body.slice(0, body.length - word.length).trim();
        changed = true;
      }
    }
  }
  return body;
};

/** Sign and bare digits, with the format's own decorations taken off. */
const strip = (text: string, format: MoneyFormat) => {
  let body = stripEnds(text.replace(MINUS, "-").trim(), format.strip ?? []);

  let negative = false;
  if (format.negative === "parentheses" && /^\(.*\)$/.test(body)) {
    negative = true;
    body = body.slice(1, -1);
  } else if (format.negative === "trailing" && body.endsWith("-")) {
    negative = true;
    body = body.slice(0, -1);
  } else if (format.negative === "suffix") {
    const match = /[A-Za-zÄÖÅäöå]+$/u.exec(body);
    const token = (match?.[0] ?? "").toUpperCase();
    negative = (format.debitWords ?? []).some((word) => token === word.toUpperCase());
    body = match ? body.slice(0, match.index) : body;
  } else if (body.startsWith("-")) {
    negative = true;
    body = body.slice(1);
  }
  return { body: body.replace(/^\+/, "").trim(), negative };
};

/** Signed minor units, read exactly as the format describes. */
export const readAmount = (text: string, format: MoneyFormat): bigint => {
  const { body, negative } = strip(text, format);
  const withoutThousands =
    format.thousands === ""
      ? body
      : body.replace(new RegExp(escapeForClass(format.thousands), "g"), "");
  const plain = withoutThousands.replace(format.decimal, ".").replace(/\s/g, "");
  if (!/^\d+(\.\d+)?$/.test(plain)) throw UNREADABLE(text);
  const { minor } = parseMoney(plain, EUR);
  return negative ? -minor : minor;
};

/**
 * A statement that prints unsigned figures in two columns: which column the
 * figure sat in is the sign, and a row filling neither is not a transaction.
 */
export const readTwoColumn = (debit: string, credit: string, format: MoneyFormat): bigint => {
  const hasDebit = debit.trim() !== "";
  const hasCredit = credit.trim() !== "";
  if (hasDebit === hasCredit) throw UNREADABLE(`${debit} | ${credit}`);
  return hasDebit ? -readAmount(debit, format) : readAmount(credit, format);
};
