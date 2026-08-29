import { EUR, parseMoney } from "../../core/money";
import type { IsoDate } from "../../core/types";
import type { BankRow } from "./bank-statement";
import type { PdfStatement } from "./bank-pdf";

/**
 * Ferratum / Multitude Bank's SweepBank statement.
 *
 * A different document in every respect from OP's: English, ISO dates, and the
 * English number format, where a comma groups thousands and a dot separates the
 * cents -- the exact reverse of the Finnish one. Reading "1,197.93" with OP's
 * rules would give 119 793,00.
 *
 * A transaction is a block of lines rather than one line: the value date, the
 * bank's reference, an optional counterparty and IBAN, the description, and
 * finally the amount together with the running balance after it.
 *
 * Kept as its own parser rather than a configuration of OP's. The two layouts
 * share nothing but the idea of a statement, and a config general enough to
 * cover both would be harder to read than either.
 */

/** `1,197.93` or `500` -- English grouping, and the cents are optional. */
const AMOUNT = String.raw`\d{1,3}(?:,\d{3})*(?:\.\d+)?`;

/** The amount and the running balance that follows it: `+ 0.07 EUR 1,697.93 EUR`. */
const MOVEMENT = new RegExp(`^([+-])\\s*(${AMOUNT})\\s*EUR\\s+(${AMOUNT})\\s*EUR$`);

/**
 * The totals line, which states what the account began and ended the period
 * with: `2 500.07 EUR -0 EUR 1,197.93 EUR 1,698 EUR`, being count, credit
 * turnover, debit turnover, initial balance and end balance.
 */
const TOTALS = new RegExp(
  `^\\d+\\s+(${AMOUNT})\\s*EUR\\s+-?(${AMOUNT})\\s*EUR\\s+(${AMOUNT})\\s*EUR\\s+(${AMOUNT})\\s*EUR$`,
);

const DATE_LINE = /^\d{4}-\d{2}-\d{2}$/;
const REFERENCE_LINE = /^\d{12,}$/;
const IBAN_LINE = /^[A-Z]{2}\d{2}[A-Z0-9]{10,}$/;

/** Removes the thousands commas so `parseMoney` sees a plain decimal. */
const normaliseAmount = (text: string): string => text.replace(/,/g, "");

/** Descriptions that mean interest was paid, rather than money transferred in. */
const INTEREST_WORDS = ["interest", "korko"];

export const parseSweepStatementText = (text: string): PdfStatement => {
  const lines = text.split("\n").map((line) => line.trim());
  const problems: Array<{ line: number; message: string }> = [];

  const totalsLine = lines.find((line) => TOTALS.test(line));
  const totals = totalsLine === undefined ? null : TOTALS.exec(totalsLine);
  if (!totals?.[3] || !totals[4]) {
    throw new Error(
      "Tiliotteesta ei löytynyt alku- ja loppusaldoa; tarkista että tiedosto on SweepBankin tiliote",
    );
  }
  const openingBalance = parseMoney(normaliseAmount(totals[3]), EUR);
  const closingBalance = parseMoney(normaliseAmount(totals[4]), EUR);

  const period = lines
    .map((line) => /^Statement period:\s*(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})$/.exec(line))
    .find((match) => match !== null);
  const from: IsoDate = period?.[1] ?? "";
  const to: IsoDate = period?.[2] ?? "";
  if (from === "" || to === "") throw new Error("Tiliotteesta ei löytynyt jaksoa");

  const rows: BankRow[] = [];
  // A block runs from a bare date line to the movement line that closes it.
  let blockDate: string | null = null;
  let blockReference: string | null = null;
  let blockDescription: string[] = [];
  let blockLine = 0;

  for (const [index, line] of lines.entries()) {
    if (DATE_LINE.test(line)) {
      blockDate = line;
      blockReference = null;
      blockDescription = [];
      blockLine = index + 1;
      continue;
    }
    if (blockDate === null) continue;

    if (REFERENCE_LINE.test(line) && blockReference === null) {
      blockReference = line;
      continue;
    }

    const movement = MOVEMENT.exec(line);
    if (!movement) {
      // Anything else inside a block is description: the counterparty, the
      // IBAN, the bank's own wording. The IBAN is dropped -- it identifies the
      // account rather than describing what happened, and it would make every
      // note unreadable.
      if (line !== "" && !IBAN_LINE.test(line)) blockDescription.push(line);
      continue;
    }

    try {
      const [, sign, amountText] = movement;
      if (sign === undefined || amountText === undefined) continue;
      const magnitude = parseMoney(normaliseAmount(amountText), EUR).minor;
      const amount = sign === "-" ? -magnitude : magnitude;
      const note = blockDescription.join(" — ");
      const interest =
        amount > 0n && INTEREST_WORDS.some((word) => note.toLowerCase().includes(word));

      rows.push({
        line: blockLine,
        date: blockDate,
        type: interest ? "INTEREST" : amount < 0n ? "WITHDRAWAL" : "DEPOSIT",
        amount,
        counterparty: blockDescription[0] ?? "",
        note,
        externalId: blockReference,
      });
    } catch (cause) {
      problems.push({
        line: blockLine,
        message: cause instanceof Error ? cause.message : "Rivin käsittely epäonnistui",
      });
    }

    blockDate = null;
    blockReference = null;
    blockDescription = [];
  }

  return { from, to, openingBalance, closingBalance, rows, problems };
};

/** True when this text is a SweepBank statement rather than another bank's. */
export const isSweepStatement = (text: string): boolean =>
  text.includes("Savings Account Statement") || text.includes("multitudebank.com");
