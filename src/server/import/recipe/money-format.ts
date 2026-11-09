import { EUR, parseMoney } from "../../../core/money.ts";
import type { MoneyFormat } from "./types.ts";

const UNREADABLE = (text: string): Error =>
  new Error(`The amount could not be read: ${JSON.stringify(text)}`);

const MINUS = /−/g;

const escapeForClass = (text: string): string => text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

/** An empty `strip` entry is skipped: it would never shrink the body and the loop would spin. */
const stripEnds = (text: string, words: readonly string[]): string => {
  const nonEmpty = words.filter((word) => word.length > 0);
  let body = text.trim();
  let changed = nonEmpty.length > 0;
  while (changed) {
    changed = false;
    for (const word of nonEmpty) {
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
    // Only a leading format may read a leading minus; another notation meeting `-1,00` must fail loudly.
  } else if (format.negative === "leading" && body.startsWith("-")) {
    negative = true;
    body = body.slice(1);
  }
  return { body: body.replace(/^\+/, "").trim(), negative };
};

export const readDecimal = (text: string, format: MoneyFormat): string => {
  const { body, negative } = strip(text, format);
  const withoutThousands =
    format.thousands === ""
      ? body
      : body.replace(new RegExp(escapeForClass(format.thousands), "g"), "");
  const plain = withoutThousands.replace(format.decimal, ".").replace(/\s/g, "");
  if (!/^\d+(\.\d+)?$/.test(plain)) throw UNREADABLE(text);
  return negative ? `-${plain}` : plain;
};

export const readAmount = (text: string, format: MoneyFormat): bigint =>
  parseMoney(readDecimal(text, format), EUR).minor;

export const readTwoColumn = (debit: string, credit: string, format: MoneyFormat): bigint => {
  const hasDebit = debit.trim() !== "";
  const hasCredit = credit.trim() !== "";
  if (hasDebit === hasCredit) throw UNREADABLE(`${debit} | ${credit}`);
  return hasDebit ? -readAmount(debit, format) : readAmount(credit, format);
};
