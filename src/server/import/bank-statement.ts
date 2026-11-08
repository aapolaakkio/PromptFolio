export type BankRow = {
  readonly line: number;
  readonly date: string;
  readonly type: "DEPOSIT" | "WITHDRAWAL" | "INTEREST";
  /** Minor units, already signed: negative for money leaving. */
  readonly amount: bigint;
  readonly counterparty: string;
  /** Counterparty and message joined, as the ledger's `note`. */
  readonly note: string;
  readonly externalId: string | null;
};

export type BankStatement = {
  readonly rows: BankRow[];
  readonly problems: Array<{ line: number; message: string }>;
};

/**
 * What kind of movement a row is, decided by the amount's sign rather than the
 * bank's label -- the opposite of the securities importer, where a mis-typed row
 * would corrupt a position. Here only cash is at stake and every label means in
 * or out, so an unrecognised one still imports correctly. Only interest needs
 * naming, being money in that is also income.
 */
export const rowType = (
  label: string,
  amount: bigint,
  interestLabels: readonly string[],
): BankRow["type"] => {
  if (amount > 0n && interestLabels.some((known) => label.toUpperCase().includes(known))) {
    return "INTEREST";
  }
  return amount < 0n ? "WITHDRAWAL" : "DEPOSIT";
};

/** Counterparty and message together, trimmed, without an empty separator. */
export const noteOf = (parts: readonly string[]): string =>
  parts
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" — ");
