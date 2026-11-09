/** `values` keeps the last of a repeated header (five `Valuutta` columns); `cells` is positional. */
export type RawRow = {
  readonly line: number;
  readonly values: Record<string, string>;
  readonly cells: readonly string[];
};

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
  | "costBasis"
  | "note"
  | "priceCurrency"
  | "portfolio";

export type FieldMapping = {
  readonly dateFormat: "iso" | "dmy";
  readonly columns: Partial<Record<CanonicalField, string>>;
  readonly ignoredTypes?: Readonly<Record<string, string>>;
  readonly columnPositions?: Partial<Record<CanonicalField, number>>;
  readonly typeMap: Record<string, string>;
  readonly amountSign?: Record<string, 1 | -1>;
  /** OP paste view prints "1,0453   kpl". */
  readonly stripUnitSuffixes?: boolean;
};

export type BrokerCsvConfig = FieldMapping & {
  readonly broker: "nordnet";
  readonly encoding: "utf-8" | "latin1" | "utf-16le";
  readonly delimiter: string;
  readonly signature: readonly string[];
};

export type OpPasteConfig = FieldMapping & {
  readonly broker: "op";
};
