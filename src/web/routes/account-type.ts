/**
 * Arvo-osuustili vs osakesäästötili, the distinction phase 4's tax reporting
 * turns on: inside an OST nothing is taxed until money is withdrawn, and then
 * only on the gain proportion of the withdrawal, so an OST disposal treated as
 * an ordinary one produces a confident wrong figure (spec §10c/C7).
 *
 * `null` is a real state, not a missing value: an account nobody has classified
 * yet. It is shown as such rather than defaulted to the ordinary case.
 */
export const ACCOUNT_TYPES = [
  { id: "aot", label: "Arvo-osuustili (AOT)" },
  { id: "ost", label: "Osakesäästötili (OST)" },
  { id: "other", label: "Muu" },
] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number]["id"];

/** Narrows a `<select>`'s raw string without a type assertion. */
export const isAccountType = (value: string): value is AccountType =>
  ACCOUNT_TYPES.some((type) => type.id === value);

export const UNSET_LABEL = "Ei valittu";

export const accountTypeLabel = (value: string | null): string =>
  ACCOUNT_TYPES.find((type) => type.id === value)?.label ?? UNSET_LABEL;

/** The stored value as a form's selection: anything unrecognised reads as unset. */
export const toSelection = (value: string | null): AccountType | "" => {
  const candidate = value ?? "";
  return isAccountType(candidate) ? candidate : "";
};
