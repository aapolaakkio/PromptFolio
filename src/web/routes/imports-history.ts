/** One entry per import ever committed, undone ones included. `createdAt` is a full instant. */
export type ImportRecord = {
  id: number;
  kind: "csv_nordnet" | "csv_op" | "csv_bank" | "csv" | "paste" | "pdf" | "vision" | "manual";
  filename: string;
  createdAt: string;
  inserted: number;
  skipped: number;
  undone: boolean;
};

/** Label for each import kind, shown in the "Source" column. */
export const IMPORT_KIND_LABELS = {
  csv_nordnet: "Nordnet (CSV)",
  csv: "CSV",
  paste: "Pasted table",
  csv_op: "OP (CSV)",
  csv_bank: "Bank statement",
  pdf: "PDF",
  vision: "Image",
  manual: "Entered by hand",
} satisfies Record<ImportRecord["kind"], string>;

/** The confirm dialog's text; the count is exactly what the undo will delete. */
export const undoConfirmMessage = (record: ImportRecord): string =>
  `Undo import "${record.filename}"? This permanently deletes ${record.inserted} ` +
  `transactions. This cannot be undone.`;

/** A factory rather than an inline arrow: static rendering never fires onClick, so tests can call it. */
export const undoClickHandler =
  (record: ImportRecord, onUndo: (record: ImportRecord) => void) => (): void =>
    onUndo(record);
