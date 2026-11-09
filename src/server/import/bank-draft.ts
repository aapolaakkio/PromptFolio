import { z } from "zod";

import { BANK_ROW_TYPES } from "../../core/types.ts";
import { EUR, formatMoney, parseMoney } from "../../core/money.ts";
import { HttpError } from "../errors.ts";
import type { PdfStatement } from "./bank-pdf.ts";
import { noteOf, type BankRow } from "./bank-statement.ts";

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in the format YYYY-MM-DD");
const Amount = z.string().min(1, "Amount is missing");

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
            type: z.enum(BANK_ROW_TYPES),
            amountEur: Amount,
            counterparty: z.string(),
            label: z.string(),
            message: z.string(),
            externalId: z.string().nullable(),
          })
          .strict(),
      )
      .max(5000),
    problems: z.array(
      z.object({
        line: z.number().int(),
        text: z.string(),
        raw: z.string().optional(),
        suggestion: z.record(z.string(), z.string()).optional(),
      }),
    ),
  })
  .strict();
export type BankDraft = z.infer<typeof BankDraft>;

const normaliseDecimal = (text: string): string => text.replace(",", ".").replace(/\s/g, "");

/** `noteOf` joins label, counterparty, message in that order; this undoes it. */
const splitNote = (note: string, counterparty: string) => {
  if (counterparty === "") return { label: "", message: note };
  if (note === counterparty) return { label: "", message: "" };
  const between = ` — ${counterparty} — `;
  const middle = note.indexOf(between);
  if (middle !== -1) {
    return { label: note.slice(0, middle), message: note.slice(middle + between.length) };
  }
  const before = `${counterparty} — `;
  if (note.startsWith(before)) return { label: "", message: note.slice(before.length) };
  const after = ` — ${counterparty}`;
  if (note.endsWith(after))
    return { label: note.slice(0, note.length - after.length), message: "" };
  return { label: "", message: note };
};

export const bankDraftFromRows = (
  rows: readonly BankRow[],
  problems: readonly { line: number; message: string; raw?: string }[],
): BankDraft => ({
  statement: null,
  rows: rows.map((row) => {
    const { label, message } = splitNote(row.note, row.counterparty);
    return {
      line: row.line,
      date: row.date,
      type: row.type,
      amountEur: formatMoney({ minor: row.amount, currency: EUR }),
      counterparty: row.counterparty,
      label,
      message,
      externalId: row.externalId,
    };
  }),
  problems: problems.map((problem) => ({
    line: problem.line,
    text: problem.message,
    raw: problem.raw,
  })),
});

export const bankDraftFromStatement = (
  statement: PdfStatement,
  unclaimed: readonly { line: number; text: string }[],
): BankDraft => ({
  statement: {
    from: statement.from,
    to: statement.to,
    openingBalanceEur: formatMoney(statement.openingBalance),
    closingBalanceEur: formatMoney(statement.closingBalance),
    maturityDate: statement.maturityDate,
  },
  rows: statement.rows.map((row) => {
    const { label, message } = splitNote(row.note, row.counterparty);
    return {
      line: row.line,
      date: row.date,
      type: row.type,
      amountEur: formatMoney({ minor: row.amount, currency: EUR }),
      counterparty: row.counterparty,
      label,
      message,
      externalId: row.externalId,
    };
  }),
  problems: [
    ...statement.problems.map((problem) => ({ line: problem.line, text: problem.message })),
    ...unclaimed.map((entry) => ({
      line: entry.line,
      text: `Unrecognised line: ${entry.text}`,
      raw: entry.text,
    })),
  ].sort((a, b) => a.line - b.line),
});

export const bankRowsFromDraft = (draft: BankDraft): BankRow[] =>
  draft.rows.map((row) => {
    let amount: bigint;
    try {
      amount = parseMoney(normaliseDecimal(row.amountEur), EUR).minor;
    } catch {
      throw new HttpError(400, `Row ${row.line}: amount "${row.amountEur}" is not a number`);
    }
    return {
      line: row.line,
      date: row.date,
      type: row.type,
      amount,
      counterparty: row.counterparty,
      note: noteOf([row.label, row.counterparty, row.message]),
      externalId: row.externalId,
    };
  });

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
