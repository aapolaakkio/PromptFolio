import type { BrokerCsvConfig, RawRow } from "./types.ts";

/**
 * The distinct account numbers a broker's export names, in the order they first
 * appear.
 *
 * Nordnet's `Salkku` column identifies which of the owner's accounts each row
 * belongs to. The importer used to ignore it, so a file covering two accounts
 * filed every row under whichever account the owner had picked -- silently
 * merging an AOT and an OST into one portfolio. That merge is measurable: for
 * the broker whose accounts were not merged, this app reproduces the broker's
 * own reported percentage to the cent; for the merged one, no definition it
 * computes reproduces the figure at all (spec §10c/C7).
 *
 * A file naming one account (or none, for a broker with no such column) is
 * fine. More than one is refused by the caller rather than split automatically:
 * the owner decides which account an import belongs to, and an export can be
 * taken again per account.
 */
export const portfoliosNamed = (
  rows: readonly RawRow[],
  config: Pick<BrokerCsvConfig, "columns" | "columnPositions">,
): string[] => {
  const position = config.columnPositions?.portfolio;
  const header = config.columns.portfolio;
  if (position === undefined && header === undefined) return [];

  const seen = new Set<string>();
  for (const row of rows) {
    const raw =
      position === undefined
        ? header === undefined
          ? ""
          : (row.values[header] ?? "")
        : (row.cells[position - 1] ?? "");
    const value = raw.trim();
    if (value !== "") seen.add(value);
  }
  return [...seen];
};
