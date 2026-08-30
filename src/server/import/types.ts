/**
 * `values` keys cells by header name and so keeps only the last of a repeated
 * one -- five columns named `Valuutta` in a real export. `cells` is the same row
 * positionally, so a config can address one occurrence by column number.
 */
export type RawRow = {
  readonly line: number;
  readonly values: Record<string, string>;
  readonly cells: readonly string[];
};

/**
 * A line that could not become a row, without aborting the file. Shaped like a
 * `DraftProblem` so the two lists merge, but `raw` is the unparsed line text:
 * at this layer the fields may never have been split at all.
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
   * The broker's own text for the row.
   *
   * The type alone cannot say what a cash movement was: a transfer to the owner's
   * own account, a subscription's cash leg that returns days later, and money
   * genuinely leaving all arrive as the same label and amount. Never parsed for
   * meaning by core -- evidence for a reader and for the classification rules.
   */
  | "note"
  /**
   * What the unit price is quoted in, when the broker states it separately.
   *
   * They differ whenever a holding trades abroad. Reading one currency for both
   * put a US share on a European listing, priced from the wrong exchange and
   * carrying no history from before that listing existed.
   */
  | "priceCurrency"
  /**
   * The broker's own account number for the row (Nordnet's `Salkku`). Never
   * imported into a transaction -- the owner chooses the account -- but read to
   * refuse a file covering more than one of them. See import/portfolios.ts.
   */
  | "portfolio";

/**
 * How to find each field's cell and turn its text into a draft row. No opinion on
 * how the bytes became rows, so a config for a format with no delimiter at all
 * can carry this without claiming an encoding it has no use for.
 */
export type FieldMapping = {
  readonly dateFormat: "iso" | "fi";
  /** Canonical field -> the broker's column header. Missing entries mean the broker omits it. */
  readonly columns: Partial<Record<CanonicalField, string>>;
  /**
   * Labels understood and deliberately not imported, with the reason shown on the
   * review screen: the second leg of an event whose first leg already carries it.
   * Distinct from a label nobody has decided about yet.
   */
  readonly ignoredTypes?: Readonly<Record<string, string>>;
  /**
   * Field to 1-based column, for a header that repeats. An entry here wins over
   * the name lookup, which would keep only the last occurrence.
   */
  readonly columnPositions?: Partial<Record<CanonicalField, number>>;
  /** The broker's transaction labels, lowercased, mapped to our types. */
  readonly typeMap: Record<string, string>;
  /**
   * Set when the amount cell is an unsigned magnitude: a 300 EUR buy and a 300 EUR
   * sell print identically, so the sign comes from the type label instead.
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
