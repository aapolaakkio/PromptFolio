export type RawRow = { readonly line: number; readonly values: Record<string, string> };

/**
 * A structural problem on one CSV line (wrong column count, malformed
 * quoting) that stops that line from becoming a `RawRow`, without aborting
 * the rest of the file. Shape matches Task 11's `DraftProblem` (`{ line,
 * message, raw }`) so the two problem lists can be merged directly; `raw`
 * here is the unparsed line text, not a field map, since at this layer we
 * may not have been able to split the line into fields at all.
 */
export type CsvProblem = { readonly line: number; readonly message: string; readonly raw: string };

export type CanonicalField =
  | "externalId"
  | "tradeDate"
  | "type"
  | "instrumentName"
  | "isin"
  | "quantity"
  | "unitPrice"
  | "fee"
  | "currency"
  | "amount";

export type BrokerCsvConfig = {
  readonly broker: "nordnet" | "op";
  readonly encoding: "utf-8" | "latin1" | "utf-16le";
  readonly delimiter: string;
  readonly dateFormat: "iso" | "fi";
  /** Canonical field -> the broker's column header. Missing entries mean the broker omits it. */
  readonly columns: Partial<Record<CanonicalField, string>>;
  /** The broker's transaction labels, lowercased, mapped to our types. */
  readonly typeMap: Record<string, string>;
  /** Headers that identify this broker's export. */
  readonly signature: readonly string[];
};
