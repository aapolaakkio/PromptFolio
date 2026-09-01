/**
 * What kind of account this is, and what kinds of that kind exist.
 *
 * The two sets never mix. A brokerage account's type decides how it is taxed --
 * inside an osakesäästötili nothing is taxed until withdrawal, and then only on
 * the gain proportion (spec 10c/C7) -- while a bank account's type decides
 * whether the money can be reached today. Offering them in one list would let
 * someone pick "osakesäästötili" for a current account, which means nothing.
 *
 * `null` is a real state for a brokerage account: one nobody has classified
 * yet. It is shown as such rather than defaulted to the ordinary case, because
 * phase 4 must refuse to report tax on an unconfirmed account instead of
 * assuming.
 */
export const ACCOUNT_KINDS = [
  { id: "brokerage", label: "Arvopaperitili" },
  { id: "bank", label: "Pankkitili" },
] as const;

export type AccountKind = (typeof ACCOUNT_KINDS)[number]["id"];

const BROKERAGE_TYPES = [
  { id: "aot", label: "Arvo-osuustili (AOT)" },
  { id: "ost", label: "Osakesäästötili (OST)" },
  { id: "other", label: "Muu" },
] as const;

const BANK_TYPES = [
  { id: "current", label: "Käyttötili" },
  { id: "savings", label: "Säästötili" },
  { id: "fixed_term", label: "Määräaikaistili" },
  { id: "credit", label: "Luottokortti" },
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

export const UNSET_LABEL = "Ei valittu";

export const accountTypeLabel = (value: string | null): string =>
  ACCOUNT_TYPES.find((type) => type.id === value)?.label ?? UNSET_LABEL;

/** The stored value as a form's selection: anything unrecognised reads as unset. */
export const toSelection = (value: string | null): AccountType | "" => {
  const candidate = value ?? "";
  return isAccountType(candidate) ? candidate : "";
};
