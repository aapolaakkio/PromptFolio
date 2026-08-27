import { z } from "zod";

/**
 * Pure types/schemas/logic for the imports screen, split out of
 * `imports.tsx` so they can be tested without rendering (this project has
 * no DOM test harness, by deliberate choice -- see `holdings-sort.ts` for
 * the same split applied to the holdings table, and `charts/palette.ts` for
 * chart colouring). `imports.test.ts` imports only this module;
 * `imports.tsx` (and `UnknownInstrumentForm.tsx`, which it renders) never
 * get loaded by a test, so neither stays out of Bun's per-file coverage
 * gate (`bunfig.toml`'s `coverageThreshold = 0.8`) instead of failing it
 * for JSX a unit test cannot exercise.
 */

/**
 * Matches `POST /api/imports/preview`/`commit` and the OP-paste
 * equivalents' shared response shape (`{ broker, filename, sha256,
 * ...Draft }`, Task 11's `Draft`/`DraftTxn`/`DraftProblem`, Task 20's
 * `POST /api/imports/op-paste/*`). `txns[].amount`/`quantity` are raw
 * minor-unit integers (money at scale 2, quantity at scale 6 -- see
 * core/money.ts), never decimal strings like `holdings.tsx`'s `Holding` --
 * the imports screen never does money arithmetic, only the one division
 * `minorToEur` does for display. `problems[].rawLine` is present only for a
 * structurally broken line that never parsed into fields at all; a
 * consumer renders it instead of `raw`'s entries when present (never both --
 * see map.ts's `DraftProblem` comment). `unknownIsins[].isin` is `null` for
 * a broker whose export carries no ISIN at all (OP's web-paste view) --
 * such a row is identified by `name` alone, never an invented ISIN.
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
  unknownIsins: Array<{ isin: string | null; name: string }>;
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
  unknownIsins: z.array(z.object({ isin: z.string().nullable(), name: z.string() })),
});

export type CommitResult = { importId: number; inserted: number; skipped: number };

export const CommitResultSchema: z.ZodType<CommitResult> = z.object({
  importId: z.number(),
  inserted: z.number(),
  skipped: z.number(),
});

export type Account = { id: number; name: string; broker: string };

export const AccountSchema: z.ZodType<Account> = z.object({
  id: z.number(),
  name: z.string(),
  broker: z.string(),
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
