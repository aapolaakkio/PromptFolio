/**
 * Account kind and its types; the two sets never mix: a brokerage type decides taxation (inside an OST nothing is taxed until withdrawal),
 * a bank type decides whether money is reachable today.
 * `null` is a real brokerage state (unclassified): shown as such, and tax reporting must refuse it rather than assume.
 */
export const ACCOUNT_KINDS = [
  { id: "brokerage", label: "Brokerage account" },
  { id: "bank", label: "Bank account" },
] as const;

export type AccountKind = (typeof ACCOUNT_KINDS)[number]["id"];

const BROKERAGE_TYPES = [
  { id: "aot", label: "Book-entry account (AOT)" },
  { id: "ost", label: "Equity savings account (OST)" },
  { id: "other", label: "Other" },
] as const;

const BANK_TYPES = [
  { id: "current", label: "Current account" },
  { id: "savings", label: "Savings account" },
  { id: "fixed_term", label: "Fixed-term account" },
  { id: "credit", label: "Credit card" },
] as const;

export const ACCOUNT_TYPES = [...BROKERAGE_TYPES, ...BANK_TYPES];

export type AccountType = (typeof ACCOUNT_TYPES)[number]["id"];

/** The types a kind may carry -- never the other kind's. */
export const typesFor = (kind: AccountKind) => (kind === "bank" ? BANK_TYPES : BROKERAGE_TYPES);

export const isAccountKind = (value: string): value is AccountKind =>
  ACCOUNT_KINDS.some((kind) => kind.id === value);

/** Narrows a `<select>`'s raw string without a type assertion. */
export const isAccountType = (value: string): value is AccountType =>
  ACCOUNT_TYPES.some((type) => type.id === value);

export const UNSET_LABEL = "Not set";

export const accountTypeLabel = (value: string | null): string =>
  ACCOUNT_TYPES.find((type) => type.id === value)?.label ?? UNSET_LABEL;

/** The stored value as a form's selection: anything unrecognised reads as unset. */
export const toSelection = (value: string | null): AccountType | "" => {
  const candidate = value ?? "";
  return isAccountType(candidate) ? candidate : "";
};
