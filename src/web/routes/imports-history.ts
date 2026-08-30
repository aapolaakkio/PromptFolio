import { z } from "zod";

/**
 * Pure types/schemas/logic for the imports-history section, split out of `imports.tsx`
 * so they can be tested without rendering (this project has no DOM test harness, by
 * deliberate choice -- see `holdings-sort.ts` for the same split applied to the
 * holdings table, and `imports-draft.ts` for the same split already applied to the
 * rest of this same page). `imports-history.test.ts` imports only this module;
 * `imports.tsx` never gets loaded by a test, so it stays out of Bun's per-file
 * coverage gate (vitest.config.ts's line threshold) for JSX a unit test cannot
 * exercise.
 */

/**
 * Matches `GET /api/imports`'s response shape (`src/server/api/imports.ts`). One
 * entry per import this user has ever committed -- undone or not, both stay listed
 * (an undone entry just carries `undone: true`), since spec calls for a full,
 * reviewable history, not a list that forgets what was undone.
 *
 * `createdAt` is a full ISO 8601 instant (not a bare `YYYY-MM-DD` date like the rest
 * of this app's `IsoDate` fields) -- this page formats it with `../lib/format.ts`'s
 * `fiDateTime`, never parses or does arithmetic on it itself.
 *
 * `inserted`/`skipped` are the exact counts `commitDraft()` produced at commit time
 * (see `server/db/schema.ts`'s `imports.insertedCount`/`skippedCount` doc for why
 * these are persisted rather than recomputed later: a skipped row was never inserted
 * at all, and an undone import's inserted rows are gone from `transactions`, so
 * neither count could be recovered from the ledger after the fact).
 */
export type ImportRecord = {
  id: number;
  kind: "csv_nordnet" | "csv_op" | "csv_bank" | "pdf" | "vision" | "manual";
  filename: string;
  createdAt: string;
  inserted: number;
  skipped: number;
  undone: boolean;
};

export const ImportRecordSchema: z.ZodType<ImportRecord> = z.object({
  id: z.number(),
  kind: z.enum(["csv_nordnet", "csv_op", "csv_bank", "pdf", "vision", "manual"]),
  filename: z.string(),
  createdAt: z.string(),
  inserted: z.number(),
  skipped: z.number(),
  undone: z.boolean(),
});

export const ImportHistorySchema = z.array(ImportRecordSchema);

/** Matches `POST /api/imports/:id/undo`'s `{ deleted }` response (`commit.ts`'s `UndoResult`). */
export type UndoResult = { deleted: number };

export const UndoResultSchema: z.ZodType<UndoResult> = z.object({ deleted: z.number() });

/** Finnish label for each `imports.kind` value this table shows in its "Lähde" column. */
export const IMPORT_KIND_LABELS = {
  csv_nordnet: "Nordnet (CSV)",
  csv_op: "OP (CSV)",
  csv_bank: "Tiliote",
  pdf: "PDF",
  vision: "Kuva",
  manual: "Käsin syötetty",
} satisfies Record<ImportRecord["kind"], string>;

/**
 * The text shown in the browser's confirm() dialog before an undo actually runs (spec:
 * "confirm before acting", stating plainly how many transactions will be removed).
 * `record.inserted` is exactly the count `undoImport()` will delete -- every
 * transaction row it removes was inserted by this same import and carries no other
 * `importId` (see `commit.ts`'s `insertRow`/`undoImport`), so this number is not an
 * estimate. Deliberately does NOT special-case a count of exactly 1 for Finnish
 * partitive/nominative agreement ("1 tapahtuma" vs "5 tapahtumaa") -- this mirrors the
 * app's own existing, established convention for the same count elsewhere (see
 * `imports.tsx`'s post-commit "`${inserted} tapahtumaa tuotu`" message), not an
 * oversight introduced here.
 */
export const undoConfirmMessage = (record: ImportRecord): string =>
  `Perutaanko tuonti "${record.filename}"? Tämä poistaa pysyvästi ${record.inserted} ` +
  `tapahtumaa. Toimintoa ei voi peruuttaa.`;

/**
 * Builds one row's undo-button click handler: calling the returned function calls
 * `onUndo` with that row's own `record`. A small curried factory instead of an inline
 * arrow written directly in `ImportHistory.tsx`'s JSX, so it can be unit-tested by
 * calling it directly -- `react-dom/server`'s `renderToStaticMarkup` (which
 * `ImportHistory.test.ts` uses) renders markup only and never actually fires an
 * `onClick`, so an inline arrow there would be defined but never invoked by any test,
 * unlike every other bit of this page's logic (spec: keep testable logic in plain
 * modules).
 */
export const undoClickHandler =
  (record: ImportRecord, onUndo: (record: ImportRecord) => void) => (): void =>
    onUndo(record);
