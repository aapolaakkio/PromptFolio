/** Pure holdings-table sorting, split out of `holdings.tsx` so it is testable without rendering. */

/**
 * Shape of `GET /api/holdings`. Money fields are decimal strings (`Number()` is for sorting only); `currency` is any ISO 4217 code.
 * `costEur` is null iff `costBasisError` is set (a SELL with no earlier BUY); that also nulls `valueEur`/`unrealisedEur`.
 * `valueEur`/`unrealisedEur` are also null when `valuationError` is set (no price or fx rate today), never a fabricated zero.
 * `weight` is a plain ratio (0.1523 = 15.23%), null iff `valueEur` is null.
 */
export type Holding = {
  instrumentId: number;
  isin: string | null;
  name: string;
  kind: "stock" | "etf" | "fund" | "cash";
  currency: string;
  priceSource: string;
  sourceKey: string;
  lookupStatus: "ok" | "pending" | "attention";
  quantity: string;
  costEur: string | null;
  valueEur: string | null;
  unrealisedEur: string | null;
  weight: number | null;
  /** Ongoing yearly charge in basis points; null while unknown. */
  ongoingChargeBp: number | null;
  /** `valueEur` x charge per year; null when either is unknown. */
  yearlyCostEur: string | null;
  /** Where the charge came from; null while unknown. `url` is a vetted public page. */
  chargeSource: { url: string | null; source: "ai" | "user" } | null;
  priceDate: string | null;
  stale: boolean;
  costBasisError: { tradeDate: string; message: string } | null;
  valuationError: string | null;
};

export type SortKey = "name" | "quantity" | "costEur" | "valueEur" | "unrealisedEur" | "weight";
export type SortDirection = "asc" | "desc";

// Locale-aware: a plain `<` (code-point) comparison misorders accented names like "Émile".
const collator = new Intl.Collator("en-GB");

/** Returns a new, sorted array; the input is never mutated (it may be React Query's cached data). */
export const sortHoldings = (
  rows: readonly Holding[],
  key: SortKey,
  direction: SortDirection,
): Holding[] => {
  const sign = direction === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    if (key === "name") return sign * collator.compare(a.name, b.name);
    // A null money field (unknown cost basis) sorts as zero: `Number(null)` is 0, and `weight` needs no separate branch.
    return sign * (Number(a[key]) - Number(b[key]));
  });
};
