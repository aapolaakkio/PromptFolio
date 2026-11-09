import { z } from "zod";

import { ACCOUNT_TYPES, type AccountType } from "./account-type.ts";

/** The imports screen logic, split out of the page so it is testable without rendering. */

/** What a preview or commit answers with. Amounts are raw minor-unit integers; `rawLine` is set only for an unparsed line, and a null ISIN means the broker export has none. */
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
    instrumentName?: string | undefined;
  }>;
  problems: Array<{
    line: number;
    message: string;
    raw: Record<string, string>;
    rawLine?: string;
    ignored?: boolean;
    suggestion?: Record<string, string>;
  }>;
  /** Checked booking proposals for corporate-action rows; the owner applies or ignores each. */
  corporateActions?: ReadonlyArray<{
    readonly lines: readonly number[];
    readonly kind: string;
    readonly terms: string;
    readonly effectiveDate: string;
    readonly sourceUrl: string;
    readonly taxNote: string;
    readonly costBasisNeeded: readonly number[];
    readonly rows: ReadonlyArray<{
      readonly line: number;
      readonly type: string;
      readonly tradeDate: string;
      readonly isin: string;
      readonly quantityText: string;
      readonly amountEur: string | null;
      readonly feeEur: string;
      readonly currency: string;
    }>;
  }>;
  unknownIsins: Array<{ isin: string | null; name: string; currency: string }>;
  added: Array<{ isin: string; name: string; currency: string; sourceKey: string | null }>;
};

/** A draft row as the table edits it: money and quantity as decimal strings. */
export type EditableTxn = {
  readonly line: number;
  readonly tradeDate: string;
  readonly type: string;
  readonly isin: string;
  readonly quantityText: string;
  readonly amountEur: string;
  readonly feeEur: string;
  readonly currency: string;
  readonly note: string;
  /** Prefilled from a model suggestion the owner has not checked yet; never sent to the commit. */
  readonly suggested?: boolean;
};

export type CommitResult = {
  importId: number;
  inserted: number;
  skipped: number;
  enriched: number;
};

export type Account = {
  id: number;
  name: string;
  broker: string;
  kind: "brokerage" | "bank";
  accountType: AccountType | null;
};

// Taken from the one list that defines them; a hand-written copy drifted.
// SAFETY: `ACCOUNT_TYPES` is a non-empty literal array, as `z.enum` requires.
const ACCOUNT_TYPE_IDS = ACCOUNT_TYPES.map((type) => type.id) as [AccountType, ...AccountType[]];

export const AccountSchema: z.ZodType<Account> = z.object({
  id: z.number(),
  name: z.string(),
  broker: z.string(),
  kind: z.enum(["brokerage", "bank"]),
  accountType: z.enum(ACCOUNT_TYPE_IDS).nullable(),
});

/** Commit stays disabled until every unknown instrument is resolved and one good row exists; `draft.problems` never block. */
export const summarise = (draft: DraftResponse) => ({
  good: draft.txns.length,
  problems: draft.problems.length,
  unknown: draft.unknownIsins.length,
  canCommit: draft.txns.length > 0 && draft.unknownIsins.length === 0,
});

/** Every file must be importable on its own: each becomes its own import record. */
export const summariseAll = (drafts: readonly DraftResponse[]) => {
  const each = drafts.map(summarise);
  return {
    good: each.reduce((sum, s) => sum + s.good, 0),
    problems: each.reduce((sum, s) => sum + s.problems, 0),
    unknown: unknownAcross(drafts).length,
    canCommit: each.length > 0 && each.every((s) => s.canCommit),
  };
};

export const unknownAcross = (drafts: readonly DraftResponse[]) => {
  const seen = new Map<string, DraftResponse["unknownIsins"][number]>();
  for (const u of drafts.flatMap((d) => d.unknownIsins)) {
    const key = u.isin ?? u.name;
    if (!seen.has(key)) seen.set(key, u);
  }
  return [...seen.values()];
};

export const minorToEur = (minor: number): string => (minor / 100).toFixed(2);
