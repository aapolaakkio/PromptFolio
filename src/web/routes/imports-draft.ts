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
    accountId: number;
    instrumentId: number | null;
    isin: string | null;
    type: string;
    tradeDate: string;
    quantity: number;
    unitPrice: number | null;
    amount: number;
    fee: number;
    tax: number;
    currency: string;
    fxRateEur: number;
    externalId: string | null;
    note: string | null;
    /** The broker's name for an instrument the import adds itself. */
    instrumentName?: string | undefined;
  }>;
  problems: Array<{
    line: number;
    message: string;
    raw: Record<string, string>;
    rawLine?: string;
    ignored?: boolean;
  }>;
  unknownIsins: Array<{ isin: string | null; name: string; currency: string }>;
};

export type CommitResult = {
  importId: number;
  inserted: number;
  skipped: number;
  /** Rows already stored that this import filled a blank field on. */
  enriched: number;
};

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

/**
 * The same over several files: every file must be importable on its own, since
 * each becomes its own import record, and a file with nothing to import would
 * leave only an empty record behind.
 */
export const summariseAll = (drafts: readonly DraftResponse[]) => {
  const each = drafts.map(summarise);
  return {
    good: each.reduce((sum, s) => sum + s.good, 0),
    problems: each.reduce((sum, s) => sum + s.problems, 0),
    unknown: unknownAcross(drafts).length,
    canCommit: each.length > 0 && each.every((s) => s.canCommit),
  };
};

/** Unknown instruments once each, however many files name them; the first file's row wins. */
export const unknownAcross = (drafts: readonly DraftResponse[]) => {
  const seen = new Map<string, DraftResponse["unknownIsins"][number]>();
  for (const u of drafts.flatMap((d) => d.unknownIsins)) {
    const key = u.isin ?? u.name;
    if (!seen.has(key)) seen.set(key, u);
  }
  return [...seen.values()];
};

/** `amount`/`fee` arrive as integer minor units (scale 2, core/money.ts) -- never a decimal string. */
export const minorToEur = (minor: number): string => (minor / 100).toFixed(2);
