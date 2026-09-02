/**
 * Editing a preview in the browser. Pure, so the screens stay thin and this
 * can be tested without a DOM; the server re-validates and re-checks every
 * draft it is sent, so nothing here is the last line of defence.
 */

export const updateRow = <T>(rows: readonly T[], index: number, patch: Partial<T>): T[] =>
  rows.map((row, at) => (at === index ? { ...row, ...patch } : row));

export const removeRow = <T>(rows: readonly T[], index: number): T[] =>
  rows.filter((_, at) => at !== index);

export const appendRow = <T>(rows: readonly T[], blank: T): T[] => [...rows, blank];

/** Cents from a decimal string as typed, or null when it is not a number yet. */
const cents = (text: string): number | null => {
  const value = Number(text.replace(",", ".").replace(/\s/g, ""));
  return Number.isFinite(value) ? Math.round(value * 100) : null;
};

const formatCents = (value: number): string => (value / 100).toFixed(2);

type Check = { readonly ok: boolean; readonly differenceEur: string };

const sumCents = (texts: readonly string[]): number | null =>
  texts.reduce<number | null>((sum, text) => {
    const value = cents(text);
    return sum === null || value === null ? null : sum + value;
  }, 0);

/**
 * Opening balance plus rows against the closing balance, recomputed on every
 * keystroke. A row that is not a number yet shows "?" rather than a wrong
 * figure. Null for a CSV, which prints no balances.
 */
export const bankBalanceCheck = (draft: {
  readonly statement: {
    readonly openingBalanceEur: string;
    readonly closingBalanceEur: string;
  } | null;
  readonly rows: readonly { readonly amountEur: string }[];
}): Check | null => {
  if (draft.statement === null) return null;
  const opening = cents(draft.statement.openingBalanceEur);
  const closing = cents(draft.statement.closingBalanceEur);
  const movement = sumCents(draft.rows.map((row) => row.amountEur));
  if (opening === null || closing === null || movement === null)
    return { ok: false, differenceEur: "?" };
  const difference = closing - (opening + movement);
  return { ok: difference === 0, differenceEur: formatCents(difference) };
};

export const holdingsTotalCheck = (
  rows: readonly { readonly marketValueEur: string }[],
  statedTotalEur: string | null,
): Check | null => {
  if (statedTotalEur === null) return null;
  const stated = cents(statedTotalEur);
  const sum = sumCents(rows.map((row) => row.marketValueEur));
  if (stated === null || sum === null) return { ok: false, differenceEur: "?" };
  const difference = stated - sum;
  return { ok: difference === 0, differenceEur: formatCents(difference) };
};

/** A problem the reader reported, as a row to fill in; the printed text stays visible until replaced. */
export const problemToRow = (problem: { readonly line: number; readonly text: string }) => ({
  line: problem.line,
  date: "",
  type: "DEPOSIT" as const,
  amountEur: "",
  counterparty: "",
  message: problem.text,
  externalId: null,
});
