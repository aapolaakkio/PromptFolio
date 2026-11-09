/** Reachability on screen: a locked deposit shows its date, unknown terms say so rather than imply spendable. */
export const availabilityLabel = (row: {
  locked: boolean;
  availableFrom: string | null;
}): string => {
  if (!row.locked) return "Available";
  return row.availableFrom === null
    ? "Locked, maturity date unknown"
    : `Locked until ${row.availableFrom}`;
};

/** What the import did with the deposit's maturity date; null when nothing happened. */
export const describeMaturity = (result: {
  maturityDate: string | null;
  maturityConflict: string | null;
}): string | null => {
  if (result.maturityConflict !== null) {
    return `The bank statement gives ${result.maturityConflict} as the maturity date, but the account has ${result.maturityDate}. Check which one is right.`;
  }
  return result.maturityDate === null ? null : `Maturity date ${result.maturityDate}.`;
};

/** What the import did to the opening balance and whether the ledger now agrees; a non-zero difference usually means a period imported twice. */
export const describeReconciliation = (result: {
  differenceEur: string;
  openingBalanceWritten: boolean;
  openingBalanceDate: string;
}): string => {
  const opening = result.openingBalanceWritten
    ? `Opening balance recorded on ${result.openingBalanceDate}.`
    : `Opening balance left unchanged (${result.openingBalanceDate}) because an earlier bank statement reaches further back.`;
  return result.differenceEur === "0.00"
    ? `${opening} The balance matches the bank statement.`
    : `${opening} NOTE: the balance differs from the bank statement by €${result.differenceEur} — the account probably already has the same transactions from another file.`;
};

export const ENTRY_LABELS = new Map<string, string>([
  ["OPENING_BALANCE", "Opening balance"],
  ["DEPOSIT", "Deposit"],
  ["WITHDRAWAL", "Withdrawal"],
  ["INTEREST", "Interest"],
]);

/** What an import did in one sentence; both counts are named, zero included, so a re-import visibly did not double anything. */
export const describeImport = (result: {
  inserted: number;
  skipped: number;
  enriched?: number;
  problems: readonly unknown[];
}): string => {
  const parts = [`${result.inserted} new transactions`, `${result.skipped} already imported`];
  if ((result.enriched ?? 0) > 0) parts.push(`${result.enriched} payees filled in`);
  if (result.problems.length > 0) parts.push(`${result.problems.length} rows could not be read`);
  return `${parts.join(", ")}.`;
};

/** A zero difference is the good case and says so: imported rows still add up to the bank. */
export const describeBalance = (result: {
  statedEur: string;
  derivedFromRowsEur: string;
  openingBalanceEur: string;
  openingBalanceDate: string;
}): string =>
  result.openingBalanceEur === "0.00"
    ? `Matches: the transactions explain the whole balance of €${result.statedEur}.`
    : `Opening balance recorded as €${result.openingBalanceEur} (${result.openingBalanceDate}); ` +
      `the transactions explain €${result.derivedFromRowsEur}.`;

/** Why a row was left out of the spending figures, in the words the screen shows. */
export const EXCLUDED_LABELS = {
  income: "income",
  "internal-transfer": "own transfer",
  investment: "investment",
  "opening-balance": "opening balance",
  "other-currency": "other currency",
} as const;
