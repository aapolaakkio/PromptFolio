import { z } from "zod";

import { EUR, formatMoney, parseMoney } from "../../core/money.ts";
import { HttpError } from "../errors.ts";
import type { BankRow } from "./bank-statement.ts";
import type { BankReading } from "./pdf-read.ts";

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Päivämäärän on oltava muotoa YYYY-MM-DD");
const Amount = z.string().min(1, "Summa puuttuu");

/**
 * A bank statement as the browser edits it and sends it back: every figure a
 * decimal string, every row addressable by its line. `statement` is present
 * for a PDF, which prints its balances, and null for a CSV, which does not.
 */
export const BankDraft = z
  .object({
    statement: z
      .object({
        from: IsoDate,
        to: IsoDate,
        openingBalanceEur: Amount,
        closingBalanceEur: Amount,
        maturityDate: IsoDate.nullable(),
      })
      .nullable(),
    rows: z
      .array(
        z
          .object({
            line: z.number().int(),
            date: IsoDate,
            type: z.enum(["DEPOSIT", "WITHDRAWAL", "INTEREST"]),
            amountEur: Amount,
            counterparty: z.string(),
            message: z.string(),
            externalId: z.string().nullable(),
          })
          .strict(),
      )
      .max(5000),
    problems: z.array(z.object({ line: z.number().int(), text: z.string() })),
  })
  .strict();
export type BankDraft = z.infer<typeof BankDraft>;

const normaliseDecimal = (text: string): string => text.replace(",", ".").replace(/\s/g, "");

/** Formats through core/money so "1500,00" and "1500.00" read back identically. */
const asEur = (text: string): string => formatMoney(parseMoney(normaliseDecimal(text), EUR));

/**
 * What kind of movement a PDF-read row is. `bank-statement.ts` has its own
 * `rowType`, but it is not exported, and its signature (a bank's printed
 * label plus a per-bank `interestLabels` list) does not fit here anyway: a
 * PDF row carries no separate label column, only a free-text message, so
 * interest is recognised the same way the model was asked to write it --
 * the word "korko" somewhere in that message.
 */
const rowType = (amountEur: string, message: string): BankDraft["rows"][number]["type"] => {
  if (/korko/i.test(message)) return "INTEREST";
  return amountEur.trim().startsWith("-") ? "WITHDRAWAL" : "DEPOSIT";
};

export const bankDraftFromReading = (reading: BankReading): BankDraft => ({
  statement: {
    from: reading.from,
    to: reading.to,
    openingBalanceEur: asEur(reading.openingBalance),
    closingBalanceEur: asEur(reading.closingBalance),
    maturityDate: reading.maturityDate,
  },
  rows: reading.rows.map((row, index) => ({
    line: index + 1,
    date: row.date,
    type: rowType(row.amount, row.message),
    amountEur: asEur(row.amount),
    counterparty: row.counterparty.trim(),
    message: row.message.trim(),
    externalId: row.reference,
  })),
  problems: reading.problems,
});

/** A CSV parse into the same draft, so one preview serves both formats. */
export const bankDraftFromRows = (
  rows: readonly BankRow[],
  problems: readonly { line: number; message: string }[],
): BankDraft => ({
  statement: null,
  rows: rows.map((row) => {
    const [counterparty = "", ...rest] = row.note.split(" — ");
    return {
      line: row.line,
      date: row.date,
      type: row.type,
      amountEur: formatMoney({ minor: row.amount, currency: EUR }),
      counterparty: row.counterparty,
      message: row.counterparty === counterparty ? rest.join(" — ") : row.note,
      externalId: row.externalId,
    };
  }),
  problems: problems.map((problem) => ({ line: problem.line, text: problem.message })),
});

/**
 * The ledger's note format for a PDF-read row: counterparty and message
 * joined with " — ", dropping an empty half. This mirrors
 * `bank-statement.ts`'s `noteOf`, minus the label it joins first -- a PDF
 * row has no label column to fold in.
 */
const noteOf = (counterparty: string, message: string): string =>
  [counterparty, message].filter((part) => part !== "").join(" — ");

/** The ledger's rows from an edited draft. A bad amount names its row. */
export const bankRowsFromDraft = (draft: BankDraft): BankRow[] =>
  draft.rows.map((row) => {
    let amount: bigint;
    try {
      amount = parseMoney(normaliseDecimal(row.amountEur), EUR).minor;
    } catch {
      throw new HttpError(400, `Rivi ${row.line}: summa "${row.amountEur}" ei ole luku`);
    }
    return {
      line: row.line,
      date: row.date,
      type: row.type,
      amount,
      counterparty: row.counterparty,
      note: noteOf(row.counterparty, row.message),
      externalId: row.externalId,
    };
  });

/**
 * Opening balance plus every row must reach the closing balance. Shown live in
 * the preview and enforced on commit; null when the draft came from a CSV,
 * which prints no balances to check against.
 */
export const checkBankDraft = (draft: BankDraft): { ok: boolean; differenceEur: string } | null => {
  if (draft.statement === null) return null;
  const rows = bankRowsFromDraft(draft);
  const movement = rows.reduce((sum, row) => sum + row.amount, 0n);
  const opening = parseMoney(normaliseDecimal(draft.statement.openingBalanceEur), EUR).minor;
  const closing = parseMoney(normaliseDecimal(draft.statement.closingBalanceEur), EUR).minor;
  const difference = closing - (opening + movement);
  return {
    ok: difference === 0n,
    differenceEur: formatMoney({ minor: difference, currency: EUR }),
  };
};
