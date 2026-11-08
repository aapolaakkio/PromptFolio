/**
 * The import history's logic, split out of the page so it can be tested without
 * rendering -- this project has no DOM test harness, by choice.
 */

/**
 * One entry per import ever committed, undone ones included: a reviewable history
 * is not one that forgets what was undone.
 *
 * `createdAt` is a full instant rather than a bare date, formatted by the page and
 * never parsed here. The counts are what the commit produced, stored because
 * neither survives in the ledger to be recomputed.
 */
export type ImportRecord = {
  id: number;
  kind: "csv_nordnet" | "csv_op" | "csv_bank" | "csv" | "paste" | "pdf" | "vision" | "manual";
  filename: string;
  createdAt: string;
  inserted: number;
  skipped: number;
  undone: boolean;
};

/** Finnish label for each `imports.kind` value this table shows in its "Lähde" column. */
export const IMPORT_KIND_LABELS = {
  csv_nordnet: "Nordnet (CSV)",
  csv: "CSV",
  paste: "Liitetty taulukko",
  csv_op: "OP (CSV)",
  csv_bank: "Tiliote",
  pdf: "PDF",
  vision: "Kuva",
  manual: "Käsin syötetty",
} satisfies Record<ImportRecord["kind"], string>;

/**
 * What the confirm dialog says before an undo runs. The count is exactly what will
 * be deleted, not an estimate: every row an undo removes was inserted by that
 * import. No special case for one, matching the app's existing wording elsewhere.
 */
export const undoConfirmMessage = (record: ImportRecord): string =>
  `Perutaanko tuonti "${record.filename}"? Tämä poistaa pysyvästi ${record.inserted} ` +
  `tapahtumaa. Toimintoa ei voi peruuttaa.`;

/**
 * One row's undo handler, as a factory rather than an inline arrow in the JSX:
 * static rendering never fires an onClick, so an inline one would be defined and
 * never invoked by any test.
 */
export const undoClickHandler =
  (record: ImportRecord, onUndo: (record: ImportRecord) => void) => (): void =>
    onUndo(record);
