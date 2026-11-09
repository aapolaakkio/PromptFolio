import type { BrokerCsvConfig, RawRow } from "./types.ts";

/** A file naming more than one account is refused by the caller: one account would silently merge e.g. an AOT and an OST. */
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
