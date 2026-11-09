import { test, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ImportHistory } from "./ImportHistory.tsx";
import type { ImportRecord } from "./imports-history.ts";

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

const noop = () => {};

test("an empty history shows a plain message, not an empty table", () => {
  const html = renderToStaticMarkup(ImportHistory({ records: [], undoingId: null, onUndo: noop }));
  expect(html).toContain("No imports yet");
  expect(html).not.toContain("<table");
});

test("renders filename, source label, and counts for each import", () => {
  const html = renderToStaticMarkup(
    ImportHistory({
      records: [record({ filename: "nordnet-2025.csv", inserted: 12, skipped: 3 })],
      undoingId: null,
      onUndo: noop,
    }),
  );
  expect(html).toContain("nordnet-2025.csv");
  expect(html).toContain("Nordnet (CSV)");
  expect(html).toContain(">12<");
  expect(html).toContain(">3<");
});

test("an active (not-undone) import shows an undo button; an undone one does not", () => {
  const html = renderToStaticMarkup(
    ImportHistory({
      records: [record({ id: 1, undone: false }), record({ id: 2, undone: true })],
      undoingId: null,
      onUndo: noop,
    }),
  );
  expect(html).toContain("Undo import");
  expect(html).toContain("undone");
  // Exactly one undo button -- the undone entry (id 2) must not offer one.
  expect(html.match(/Undo import/g)).toHaveLength(1);
});

test("the entry an undo is in flight for shows a disabled, in-progress button", () => {
  const html = renderToStaticMarkup(
    ImportHistory({ records: [record({ id: 1 })], undoingId: 1, onUndo: noop }),
  );
  expect(html).toContain("Undoing…");
  expect(html).toContain("disabled");
});
