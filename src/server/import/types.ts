/**
 * `values` maps header name -> cell text, built by `Object.fromEntries`, so
 * a header name that repeats keeps only its last occurrence -- harmless for
 * a uniquely-named column, but silent data loss for one that doesn't (the
 * Nordnet transaction export has five columns named `Valuutta`). `cells`
 * is the same row's every value, positionally, in header order, so a
 * `BrokerCsvConfig.columnPositions` entry can address one specific
 * occurrence of a repeated header by its 1-based column number instead of
 * going through the lossy `values` map.
 */
export type RawRow = {
  readonly line: number;
  readonly values: Record<string, string>;
  readonly cells: readonly string[];
};

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
  /**
   * Canonical field -> 1-based column position, for a header that repeats
   * (Nordnet's transaction export has five columns named `Valuutta`, at
   * positions 13, 15, 17, 19 and 28 -- only position 13 is the transaction
   * currency). When a field has an entry here, it wins over `columns` for
   * that field: the value is read from `RawRow.cells` by position, never
   * from the name-keyed (and therefore last-wins) `values` map.
   */
  readonly columnPositions?: Partial<Record<CanonicalField, number>>;
  /** The broker's transaction labels, lowercased, mapped to our types. */
  readonly typeMap: Record<string, string>;
  /**
   * Set when the broker's `amount` cell is an unsigned magnitude rather
   * than a signed cash flow (OP's web-paste `YHTEENSÄ`: a 300 EUR buy and
   * a 300 EUR sell render identically). Maps the row's type label
   * (lowercased, matching `typeMap`'s keys) to the sign the parsed
   * magnitude must be given. A label with no entry here defaults to +1.
   * Omitted entirely for a broker whose amount already carries its own
   * sign (Nordnet's `Summa`).
   */
  readonly amountSign?: Record<string, 1 | -1>;
  /**
   * Set when this broker's numeric cells carry a trailing unit label (OP's
   * web-paste view renders "1,0453 kpl" and "286,99 EUR", not bare
   * numbers). Strips a trailing letter-run from `quantity`, `unitPrice`,
   * `fee` and `amount` before they reach `parseMoney`/`parseQuantity`.
   */
  readonly stripUnitSuffixes?: boolean;
  /** Headers that identify this broker's export. */
  readonly signature: readonly string[];
};
