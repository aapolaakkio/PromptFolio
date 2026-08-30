import { z } from "zod";

import { ACCOUNT_TYPES, type AccountType } from "./account-type.ts";

/**
 * The imports screen's logic, split out of the page so it can be tested without
 * rendering -- this project has no DOM test harness, by choice.
 */

/**
 * What a preview or a commit answers with.
 *
 * Amounts and quantities are raw minor-unit integers rather than decimal strings:
 * this screen does no money arithmetic beyond the one division for display.
 *
 * `rawLine` is present only for a line that never parsed into fields, and a
 * consumer renders it instead of the fields, never both. A null ISIN means a
 * broker whose export carries none -- identified by name, never an invented one.
 */
export type DraftResponse = {
  broker: string;
  filename: string;
  sha256: string;
  txns: Array<{
    line: number;
    type: string;
    tradeDate: string;
    isin: string | null;
    quantity: number;
    amount: number;
    currency: string;
  }>;
  problems: Array<{
    line: number;
    message: string;
    raw: Record<string, string>;
    rawLine?: string;
  }>;
  unknownIsins: Array<{ isin: string | null; name: string; currency: string }>;
};

export const DraftResponseSchema: z.ZodType<DraftResponse> = z.object({
  broker: z.string(),
  filename: z.string(),
  sha256: z.string(),
  txns: z.array(
    z.object({
      line: z.number(),
      type: z.string(),
      tradeDate: z.string(),
      isin: z.string().nullable(),
      quantity: z.number(),
      amount: z.number(),
      currency: z.string(),
    }),
  ),
  problems: z.array(
    z.object({
      line: z.number(),
      message: z.string(),
      raw: z.record(z.string(), z.string()),
      rawLine: z.string().optional(),
    }),
  ),
  unknownIsins: z.array(
    z.object({ isin: z.string().nullable(), name: z.string(), currency: z.string() }),
  ),
});

export type CommitResult = {
  importId: number;
  inserted: number;
  skipped: number;
  /** Rows already stored that this import filled a blank field on. */
  enriched: number;
};

export const CommitResultSchema: z.ZodType<CommitResult> = z.object({
  importId: z.number(),
  inserted: z.number(),
  skipped: z.number(),
  enriched: z.number(),
});

export type Account = {
  id: number;
  name: string;
  broker: string;
  /** Whether the account holds investments or money -- fixed at creation. */
  kind: "brokerage" | "bank";
  /** null until the owner classifies it -- see routes/account-type.ts. */
  accountType: AccountType | null;
};

/**
 * Taken from the one list that defines them rather than written out again. They
 * were written out again and drifted: a new account type left this enum listing
 * the older six, and every screen reading accounts failed at once.
 */
// SAFETY: `z.enum` needs a non-empty tuple, and `ACCOUNT_TYPES` is a literal
// array with entries for both kinds -- it cannot be empty without the app
// having no account types at all.
const ACCOUNT_TYPE_IDS = ACCOUNT_TYPES.map((type) => type.id) as [AccountType, ...AccountType[]];

export const AccountSchema: z.ZodType<Account> = z.object({
  id: z.number(),
  name: z.string(),
  broker: z.string(),
  kind: z.enum(["brokerage", "bank"]),
  accountType: z.enum(ACCOUNT_TYPE_IDS).nullable(),
});

export const AccountsSchema = z.array(AccountSchema);

/**
 * The screen's central rule, made checkable in isolation: commit stays
 * disabled until every unknown instrument is resolved AND there is at
 * least one good row to import. Problems (`draft.problems`) are shown but
 * never block commit -- the user chooses to proceed without those rows.
 */
export const summarise = (draft: DraftResponse) => ({
  good: draft.txns.length,
  problems: draft.problems.length,
  unknown: draft.unknownIsins.length,
  canCommit: draft.txns.length > 0 && draft.unknownIsins.length === 0,
});

/** `amount`/`fee` arrive as integer minor units (scale 2, core/money.ts) -- never a decimal string. */
export const minorToEur = (minor: number): string => (minor / 100).toFixed(2);
