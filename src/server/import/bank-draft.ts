import { z } from "zod";

import { EUR, formatMoney, parseMoney } from "../../core/money.ts";
import { HttpError } from "../errors.ts";
import type { PdfStatement } from "./bank-pdf.ts";
import type { BankRow } from "./bank-statement.ts";

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
            /** The bank's own transaction-type text (e.g. "PKORTTIMAKSU"). */
            label: z.string(),
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

/**
 * Splits a CSV-stored note back into label and message, using the
 * counterparty already carried on `BankRow` to place the cut: `noteOf`
 * below always joins label, counterparty, message in that order, dropping
 * empty parts, so when the counterparty is non-empty it appears in the note
 * verbatim, with the label (if any) before it and the message (if any)
 * after. Rebuilding through `noteOf` then reproduces the note exactly.
 */
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
  // The stored note does not contain the counterparty as its own segment --
  // not something `bank-statement.ts` produces, but kept safe rather than
  // dropping text: the whole note becomes the message.
  return { label: "", message: note };
};

/** A CSV parse into the same draft, so one preview serves both formats. */
export const bankDraftFromRows = (
  rows: readonly BankRow[],
  problems: readonly { line: number; message: string }[],
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
  problems: problems.map((problem) => ({ line: problem.line, text: problem.message })),
});

/**
 * A recipe-read statement as the browser edits it. Unclaimed lines ride along
 * as problems: a line nobody could account for is the owner's to look at, and
 * silently dropping it is how a missing transaction stays missing.
 */
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
    // Through `splitNote`, as a CSV row is: a recipe captures the bank's own
    // transaction-type text into the note, so putting the whole note in
    // `message` would print the counterparty twice on the way back.
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
    ...unclaimed.map((entry) => ({ line: entry.line, text: `Tunnistamaton rivi: ${entry.text}` })),
  ].sort((a, b) => a.line - b.line),
});

/**
 * The ledger's note format: label, counterparty and message joined with
 * " — ", dropping any empty part. Mirrors `bank-statement.ts`'s own
 * `noteOf` (not exported, so not reusable directly) exactly, so a CSV row's
 * note survives the round trip through a draft unchanged.
 */
const noteOf = (label: string, counterparty: string, message: string): string =>
  [label, counterparty, message]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" — ");

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
      note: noteOf(row.label, row.counterparty, row.message),
      externalId: row.externalId,
    };
  });

/**
 * Opening balance plus every row must reach the closing balance. Shown live in
 * the preview and enforced on commit; null when the draft came from a CSV,
 * which prints no balances to check against. Throws the same `HttpError` as
 * `bankRowsFromDraft` when a row's hand-edited amount is not a number --
 * the preview surfaces that as the row's own error rather than a balance.
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
