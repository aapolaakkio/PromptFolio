import { appendRow, removeRow, updateRow } from "./draft-edit.ts";

export type Column<T> = {
  readonly key: keyof T & string;
  readonly label: string;
  readonly kind: "text" | "date" | "decimal" | "select";
  /** The choices, for a "select" column. */
  readonly options?: readonly { value: string; label: string }[];
  readonly numeric?: boolean;
};

/** An import preview as editable inputs: rows can be removed or added; the server validates again. */
export const DraftTable = <T extends { readonly line: number }>({
  rows,
  columns,
  onChange,
  blank,
  fieldErrors = {},
  isSuggested = () => false,
}: {
  readonly rows: readonly T[];
  readonly columns: readonly Column<T>[];
  readonly onChange: (rows: T[]) => void;
  readonly blank: () => T;
  /** Server-side complaints keyed by line, shown under the row they name. */
  readonly fieldErrors?: Record<number, string>;
  /** Rows whose values came from a model suggestion, marked until the owner has checked them. */
  readonly isSuggested?: (row: T) => boolean;
}) => (
  <div className="grid gap-2">
    <div className="max-h-112 overflow-auto rounded border border-line">
      <table>
        <thead className="sticky top-0 bg-surface">
          <tr>
            <th>Row</th>
            {columns.map((column) => (
              <th key={column.key} className={column.numeric ? "num" : undefined}>
                {column.label}
              </th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.line}-${index}`}>
              <td className="num">
                {row.line}
                {isSuggested(row) && (
                  <span
                    className="ml-2 rounded-full border border-accent px-2 py-0.5 text-xs text-accent"
                    title="Values suggested by AI from the printed text"
                  >
                    AI suggestion — check
                  </span>
                )}
              </td>
              {columns.map((column) => {
                const value = String(row[column.key] ?? "");
                const set = (next: string) =>
                  // SAFETY: every column edits a string field of T; `key` is `keyof T`.
                  onChange(updateRow(rows, index, { [column.key]: next } as Partial<T>));
                return (
                  <td key={column.key} className={column.numeric ? "num" : undefined}>
                    {column.options !== undefined ? (
                      <select value={value} onChange={(e) => set(e.target.value)}>
                        {column.options.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={column.kind === "date" ? "date" : "text"}
                        inputMode={column.kind === "decimal" ? "decimal" : undefined}
                        value={value}
                        onChange={(e) => set(e.target.value)}
                      />
                    )}
                  </td>
                );
              })}
              <td>
                <button
                  type="button"
                  className="text-sm"
                  onClick={() => onChange(removeRow(rows, index))}
                >
                  Remove
                </button>
                {fieldErrors[row.line] !== undefined && (
                  <p role="alert" className="text-loss text-xs">
                    {fieldErrors[row.line]}
                  </p>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <button type="button" className="text-sm" onClick={() => onChange(appendRow(rows, blank()))}>
      + Add row
    </button>
  </div>
);
