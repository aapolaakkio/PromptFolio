import { formatDateTime } from "../lib/format.ts";
import { IMPORT_KIND_LABELS, undoClickHandler, type ImportRecord } from "./imports-history.ts";

type ImportHistoryProps = {
  readonly records: readonly ImportRecord[];
  /** The id of the import an undo request is currently in flight for, or `null`. */
  readonly undoingId: number | null;
  /** Called once the caller confirmed the undo; confirmation lives in `imports.tsx` so this stays props-in/JSX-out. */
  readonly onUndo: (record: ImportRecord) => void;
};

/** Every committed import, newest first, with an undo control on each one not yet undone. */
export const ImportHistory = ({ records, undoingId, onUndo }: ImportHistoryProps) => {
  if (records.length === 0) {
    return <p className="text-muted">No imports yet.</p>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Source</th>
          <th>File</th>
          <th className="num">Imported</th>
          <th className="num">Skipped</th>
          <th>Status</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {records.map((record) => (
          <tr key={record.id}>
            <td>{formatDateTime(record.createdAt)}</td>
            <td>{IMPORT_KIND_LABELS[record.kind]}</td>
            <td>{record.filename}</td>
            <td className="num">{record.inserted}</td>
            <td className="num">{record.skipped}</td>
            <td>
              {record.undone ? (
                <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">
                  undone
                </span>
              ) : (
                "active"
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
                  {undoingId === record.id ? "Undoing…" : "Undo import"}
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};
