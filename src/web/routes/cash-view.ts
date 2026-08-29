import { z } from "zod";

/** Response shapes the cash screen reads, parsed at the boundary like every other. */

export const CashSchema = z.object({
  rows: z.array(
    z.object({
      accountId: z.number(),
      accountName: z.string(),
      currency: z.string(),
      amount: z.string(),
      valueEur: z.string().nullable(),
      locked: z.boolean(),
      availableFrom: z.string().nullable(),
    }),
  ),
  totalEur: z.string(),
  availableEur: z.string(),
  lockedEur: z.string(),
});

/**
 * How a balance's reachability reads on screen.
 *
 * A deposit locked until a date says so with the date; one whose terms nobody
 * entered says that instead of implying it is spendable, because "we do not
 * know when this frees up" and "you can use it now" are different answers.
 */
export const availabilityLabel = (row: {
  locked: boolean;
  availableFrom: string | null;
}): string => {
  if (!row.locked) return "Käytettävissä";
  return row.availableFrom === null
    ? "Sidottu, eräpäivä ei tiedossa"
    : `Sidottu ${row.availableFrom} asti`;
};

export const SpendingSchema = z.object({
  from: z.string(),
  to: z.string(),
  totalEur: z.string(),
  groups: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      totalEur: z.string(),
      count: z.number(),
    }),
  ),
  uncategorisedShare: z.number(),
});

export const BankPreviewSchema = z.object({
  bank: z.string(),
  rows: z.number(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  totalInEur: z.string(),
  totalOutEur: z.string(),
  openingBalanceEur: z.string().nullable(),
  closingBalanceEur: z.string().nullable(),
  maturityDate: z.string().nullable(),
  verified: z.boolean(),
  problems: z.array(z.object({ line: z.number(), message: z.string() })),
  sample: z.array(
    z.object({
      date: z.string(),
      type: z.string(),
      amountEur: z.string(),
      note: z.string(),
    }),
  ),
});

export const BankCommitSchema = z.object({
  importId: z.number(),
  inserted: z.number(),
  skipped: z.number(),
  problems: z.array(z.object({ line: z.number(), message: z.string() })),
});

export const BalanceSchema = z.object({
  on: z.string(),
  statedEur: z.string(),
  derivedFromRowsEur: z.string(),
  openingBalanceEur: z.string(),
  openingBalanceDate: z.string(),
});

export const CashEntriesSchema = z.object({
  entries: z.array(
    z.object({
      id: z.number(),
      type: z.string(),
      tradeDate: z.string(),
      amount: z.string(),
      currency: z.string(),
      note: z.string().nullable(),
    }),
  ),
});

export const ENTRY_LABELS = new Map<string, string>([
  ["OPENING_BALANCE", "Alkusaldo"],
  ["DEPOSIT", "Talletus"],
  ["WITHDRAWAL", "Nosto"],
  ["INTEREST", "Korko"],
]);

/**
 * What an import actually did, in one sentence.
 *
 * Both numbers are always named, including a zero: "0 uutta, 5 jo tuotua" is
 * the answer that tells someone their re-import worked as intended, whereas a
 * bare "valmis" leaves them wondering whether it doubled anything.
 */
export const describeImport = (result: {
  inserted: number;
  skipped: number;
  problems: readonly unknown[];
}): string => {
  const parts = [`${result.inserted} uutta tapahtumaa`, `${result.skipped} jo tuotua`];
  if (result.problems.length > 0) parts.push(`${result.problems.length} riviä ei voitu lukea`);
  return `${parts.join(", ")}.`;
};

/**
 * How a reconciliation came out.
 *
 * A zero difference is the good case and says so plainly: it means the imported
 * rows still add up to what the bank reports, which is the check this screen
 * exists to give.
 */
export const describeBalance = (result: {
  statedEur: string;
  derivedFromRowsEur: string;
  openingBalanceEur: string;
  openingBalanceDate: string;
}): string =>
  result.openingBalanceEur === "0.00"
    ? `Täsmää: tapahtumat selittävät koko saldon ${result.statedEur} €.`
    : `Alkusaldoksi kirjattiin ${result.openingBalanceEur} € (${result.openingBalanceDate}); ` +
      `tapahtumat selittävät ${result.derivedFromRowsEur} €.`;
