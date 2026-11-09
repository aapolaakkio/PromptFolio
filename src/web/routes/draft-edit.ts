import { minorToEur } from "./imports-draft.ts";

/** Pure preview editing; the server re-validates every draft. */

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

type Check = { readonly ok: boolean; readonly differenceEur: string };

const sumCents = (texts: readonly string[]): number | null =>
  texts.reduce<number | null>((sum, text) => {
    const value = cents(text);
    return sum === null || value === null ? null : sum + value;
  }, 0);

/** Opening balance plus rows against closing balance, live; a non-number row shows "?". Null for a CSV (no balances). */
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
  return { ok: difference === 0, differenceEur: minorToEur(difference) };
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
  return { ok: difference === 0, differenceEur: minorToEur(difference) };
};

/** The suggested values for the listed fields only: the server's answer is not trusted to name fields. */
export const pickSuggested = <K extends string>(
  suggestion: Readonly<Record<string, string>> | undefined,
  keys: readonly K[],
): Partial<Record<K, string>> =>
  // SAFETY: only the listed keys are copied.
  Object.fromEntries(
    keys.flatMap((key) => {
      const value = suggestion?.[key];
      return value === undefined ? [] : [[key, value]];
    }),
  ) as Partial<Record<K, string>>;

const BANK_TYPES = ["DEPOSIT", "WITHDRAWAL", "INTEREST"] as const;

/** A problem the reader reported, as a row to fill in; the printed text stays visible until replaced. A suggestion only prefills. */
export const problemToRow = (problem: {
  readonly line: number;
  readonly text: string;
  readonly suggestion?: Readonly<Record<string, string>> | undefined;
}) => {
  const suggested = pickSuggested(problem.suggestion, [
    "date",
    "type",
    "amountEur",
    "counterparty",
  ]);
  return {
    line: problem.line,
    date: suggested.date ?? "",
    type: BANK_TYPES.find((type) => type === suggested.type) ?? "DEPOSIT",
    amountEur: suggested.amountEur ?? "",
    counterparty: suggested.counterparty ?? "",
    message: problem.text,
    externalId: null,
  };
};
