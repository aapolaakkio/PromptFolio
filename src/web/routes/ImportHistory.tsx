import { fiDateTime } from "../lib/format.ts";
import { IMPORT_KIND_LABELS, undoClickHandler, type ImportRecord } from "./imports-history.ts";

export type ImportHistoryProps = {
  readonly records: readonly ImportRecord[];
  /** The id of the import an undo request is currently in flight for, or `null`. */
  readonly undoingId: number | null;
  /**
   * Called once the caller has already confirmed with the user (via
   * `window.confirm(undoConfirmMessage(record))`) that this specific undo should
   * proceed. Confirmation deliberately lives one level up, in `imports.tsx`, not in
   * this component -- `window.confirm` is a browser global with no React hook of its
   * own, and keeping it out of this file is what lets this file stay pure props-in/
   * JSX-out and renderable with `react-dom/server`'s `renderToStaticMarkup` (see
   * `imports-history.test.ts`'s sibling `imports-history.ts` for the same "keep it
   * testable" split, and `session-gate.tsx`'s own doc for the same pattern applied to
   * this project's other hook-free presentational component).
   */
  readonly onUndo: (record: ImportRecord) => void;
};

/**
 * Renders the imports screen's history section: every import this user has ever
 * committed, newest first (the order `GET /api/imports` already returns them in --
 * see that route's own doc), with an undo control on each entry that has not already
 * been undone. Closes the gap `POST /api/imports/:id/undo` left reachable only from
 * `curl`: an import id used to appear once, in a one-time success message, and then
 * be gone.
 */
export const ImportHistory = ({ records, undoingId, onUndo }: ImportHistoryProps) => {
  if (records.length === 0) {
    return <p className="text-muted">Ei vielä tuonteja.</p>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Aika</th>
          <th>Lähde</th>
          <th>Tiedosto</th>
          <th className="num">Tuotu</th>
          <th className="num">Ohitettu</th>
          <th>Tila</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {records.map((record) => (
          <tr key={record.id}>
            <td>{fiDateTime(record.createdAt)}</td>
            <td>{IMPORT_KIND_LABELS[record.kind]}</td>
            <td>{record.filename}</td>
            <td className="num">{record.inserted}</td>
            <td className="num">{record.skipped}</td>
            <td>
              {record.undone ? (
                <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">
                  peruttu
                </span>
              ) : (
                "voimassa"
              )}
            </td>
            <td>
              {!record.undone && (
                <button
                  type="button"
                  className="text-xs"
                  disabled={undoingId === record.id}
                  onClick={undoClickHandler(record, onUndo)}
                >
                  {undoingId === record.id ? "Perutaan…" : "Peru tuonti"}
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};
