export type BankRow = {
  readonly line: number;
  readonly date: string;
  readonly type: "DEPOSIT" | "WITHDRAWAL" | "INTEREST";
  readonly amount: bigint;
  readonly counterparty: string;
  readonly note: string;
  readonly externalId: string | null;
};

export type BankStatement = {
  readonly rows: BankRow[];
  readonly problems: Array<{ line: number; message: string; raw?: string }>;
};

/** Type comes from the amount sign, not the bank label: only cash is at stake. */
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

export const noteOf = (parts: readonly string[]): string =>
  parts
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" — ");
