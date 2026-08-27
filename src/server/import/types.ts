export type RawRow = { readonly line: number; readonly values: Record<string, string> };

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
