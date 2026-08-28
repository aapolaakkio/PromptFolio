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
  | "amount"
  /**
   * The acquisition value a broker states for a row that brings units in
   * without any cash changing hands -- a merger or share swap, where the
   * original cost rides across to the new instrument. `amount` is zero on
   * such a row, so without this the new holding would get a cost basis of
   * zero and report its entire value as gain.
   */
  | "costBasis"
  /**
   * The broker's own number for the account a row belongs to -- Nordnet prints
   * it in every row's `Salkku` column. One export routinely covers several
   * accounts (an arvo-osuustili and an osakesäästötili are separate accounts,
   * taxed differently), so rows are filed per account rather than all under
   * whichever one happened to be selected on the import screen.
   */
  | "accountRef";

/**
 * The part of a broker's configuration `mapRows` actually consumes:
 * how to find each canonical field's cell, and how to turn its raw text
 * into a `DraftTxn`. Deliberately has no opinion on *how the bytes reached
 * `RawRow[]`* -- that is `BrokerCsvConfig`'s job for a genuinely delimited
 * export (Nordnet). OP's web-paste view is not delimited at all (see
 * `op-paste.ts`), so `OpPasteConfig` carries a `FieldMapping` without ever
 * claiming an `encoding`/`delimiter`/`signature` that wouldn't mean
 * anything for it.
 */
export type FieldMapping = {
  readonly dateFormat: "iso" | "fi";
  /** Canonical field -> the broker's column header. Missing entries mean the broker omits it. */
  readonly columns: Partial<Record<CanonicalField, string>>;
  /**
   * Type labels that are real, understood, and deliberately not imported,
   * mapped to the reason shown on the review screen. These are the second
   * leg of a two-row event whose first leg already carries the whole event:
   * importing both would double a cash balance or a position. Distinct from
   * a label missing from `typeMap`, which means "nobody has decided what
   * this is yet".
   */
  readonly ignoredTypes?: Readonly<Record<string, string>>;
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
   * than a signed cash flow (OP's web-paste `Yhteensä`: a 300 EUR buy and
   * a 300 EUR sell render identically). Maps the row's type label
   * (lowercased, matching `typeMap`'s keys) to the sign the parsed
   * magnitude must be given. A label with no entry here defaults to +1.
   * Omitted entirely for a broker whose amount already carries its own
   * sign (Nordnet's `Summa`).
   */
  readonly amountSign?: Record<string, 1 | -1>;
  /**
   * Set when this broker's numeric cells carry a trailing unit label (OP's
   * web-paste view renders "1,0453   kpl" and "286,99   EUR", not bare
   * numbers). Strips a trailing letter-run from `quantity`, `unitPrice`,
   * `fee` and `amount` before they reach `parseMoney`/`parseQuantity`.
   */
  readonly stripUnitSuffixes?: boolean;
};

/** A genuinely delimited broker export, parseable by `parseCsv`. Currently only Nordnet. */
export type BrokerCsvConfig = FieldMapping & {
  readonly broker: "nordnet";
  readonly encoding: "utf-8" | "latin1" | "utf-16le";
  readonly delimiter: string;
  /** Headers that identify this broker's export. */
  readonly signature: readonly string[];
};

/**
 * OP's web-paste transaction view: newline-separated, no delimiter, no
 * fixed column count per row (a fee line is present or absent). Parsed by
 * `parseOpPaste`, not `parseCsv` -- there is no `encoding`/`delimiter` to
 * declare, and no single header row for `detectBroker`'s signature match
 * to run against, so this type carries none of those fields.
 */
export type OpPasteConfig = FieldMapping & {
  readonly broker: "op";
};
