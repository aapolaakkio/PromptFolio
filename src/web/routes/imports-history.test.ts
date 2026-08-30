import { test, expect } from "vitest";
import {
  ImportHistorySchema,
  IMPORT_KIND_LABELS,
  undoClickHandler,
  undoConfirmMessage,
  UndoResultSchema,
  type ImportRecord,
} from "./imports-history.ts";

const record = (over: Partial<ImportRecord> = {}): ImportRecord => ({
  id: 1,
  kind: "csv_nordnet",
  filename: "export.csv",
  createdAt: "2026-08-27T10:15:00.000Z",
  inserted: 5,
  skipped: 2,
  undone: false,
  ...over,
});

test("ImportHistorySchema parses a real GET /api/imports response shape", () => {
  const body = [record(), record({ id: 2, kind: "csv_op", undone: true })];
  expect(ImportHistorySchema.parse(body)).toEqual(body);
});

test("ImportHistorySchema rejects a malformed entry instead of silently coercing it", () => {
  const malformed = [{ ...record(), kind: "not-a-real-kind" }];
  expect(() => ImportHistorySchema.parse(malformed)).toThrow();
});

test("UndoResultSchema parses POST /api/imports/:id/undo's { deleted } response", () => {
  expect(UndoResultSchema.parse({ deleted: 3 })).toEqual({ deleted: 3 });
});

test("every import kind has a non-empty Finnish label", () => {
  const kinds: ImportRecord["kind"][] = ["csv_nordnet", "csv_op", "pdf", "vision", "manual"];
  for (const kind of kinds) {
    expect(IMPORT_KIND_LABELS[kind].length).toBeGreaterThan(0);
  }
});

test("undo confirmation names the file and states exactly how many transactions will be removed", () => {
  const message = undoConfirmMessage(record({ filename: "nordnet-2025.csv", inserted: 12 }));
  expect(message).toContain("nordnet-2025.csv");
  expect(message).toContain("12");
  expect(message).toContain("tapahtumaa");
});

test("undo confirmation reflects a different import's own inserted count, not a stale one", () => {
  const message = undoConfirmMessage(record({ inserted: 0 }));
  expect(message).toContain("0 tapahtumaa");
});

test("undoClickHandler's returned callback calls onUndo with exactly that row's record", () => {
  const calls: ImportRecord[] = [];
  const target = record({ id: 7 });
  const handler = undoClickHandler(target, (r) => calls.push(r));
  expect(calls).toEqual([]);
  handler();
  expect(calls).toEqual([target]);
});
