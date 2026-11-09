export const DROPPED_KINDS = [
  "broker-transactions",
  "bank-statement",
  "holdings-statement",
  "unknown",
] as const;
export type DroppedKind = (typeof DROPPED_KINDS)[number];

/** One dropped file with what the server made of it; the owner may change kind and account. */
export type Dropped = {
  readonly name: string;
  readonly kind: DroppedKind;
  readonly accountId: number | null;
  readonly reason: string;
  readonly file: File;
};

export type DropGroup = {
  readonly kind: DroppedKind;
  readonly accountId: number | null;
  readonly files: readonly Dropped[];
};

export const KIND_LABELS = {
  "broker-transactions": "broker transactions",
  "bank-statement": "bank statement",
  "holdings-statement": "holdings statement",
  unknown: "not recognised",
} as const satisfies Record<DroppedKind, string>;

export const groupDropped = (entries: readonly Dropped[]): DropGroup[] =>
  entries.reduce<DropGroup[]>((groups, entry) => {
    const at = groups.findIndex((g) => g.kind === entry.kind && g.accountId === entry.accountId);
    return at === -1
      ? [...groups, { kind: entry.kind, accountId: entry.accountId, files: [entry] }]
      : groups.map((g, i) => (i === at ? { ...g, files: [...g.files, entry] } : g));
  }, []);

/** The accounts a kind of document can belong to: bank statements to bank accounts, the rest to brokerage accounts. */
export const accountsForKind = <A extends { readonly kind: "brokerage" | "bank" }>(
  kind: DroppedKind,
  accounts: readonly A[],
): A[] => {
  if (kind === "unknown") return [];
  const wanted = kind === "bank-statement" ? "bank" : "brokerage";
  return accounts.filter((account) => account.kind === wanted);
};
