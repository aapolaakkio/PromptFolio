/**
 * Pure sorting logic for the holdings table, split out of `holdings.tsx` so
 * it can be tested without rendering (this project has no DOM test harness,
 * by deliberate choice -- see `charts/palette.ts` for the same split
 * applied to chart colouring). `holdings.test.ts` imports only this module;
 * `holdings.tsx` never gets loaded by a test, so it stays out of Bun's
 * per-file coverage gate (`bunfig.toml`'s `coverageThreshold = 0.8`)
 * instead of failing it for JSX that a unit test cannot exercise.
 */

/**
 * Matches `GET /api/holdings`'s `HoldingView` shape (`src/server/valuation.ts`).
 * `currency` is the instrument's own quotation currency, any ISO 4217 code --
 * the user holds both EUR and SEK instruments, so this is deliberately a
 * plain `string`, not a closed union. It is display-only: `costEur`,
 * `valueEur` and `unrealisedEur` are already converted to EUR server-side,
 * and the page never converts or otherwise does arithmetic on money --
 * every monetary field is a decimal string, formatted for display and
 * nothing else. `Number(...)` is used below only for sorting, never to
 * compute an amount.
 *
 * `costEur` is `null` exactly when `costBasisError` is non-null: a SELL with no
 * matching earlier BUY on the ledger (e.g. one page of a multi-page OP import
 * pasted out of order) makes this position's cost basis genuinely unknown -- not
 * zero, not stale, unknown -- until the missing purchase is imported. When that
 * happens `valueEur`/`unrealisedEur` are null too (an unrealised gain needs both
 * sides).
 *
 * `valueEur`/`unrealisedEur` can independently be `null` for a second, unrelated
 * reason: `valuationError` non-null, meaning no price is known for today, or (for a
 * non-EUR instrument) no fx rate is known for today. `costEur` stays populated in
 * that case -- cost basis does not depend on today's market data. Never a
 * fabricated `0,00 €` either way (see `server/valuation.ts`'s `HoldingView` doc).
 */
export type Holding = {
  instrumentId: number;
  isin: string;
  name: string;
  kind: "stock" | "etf" | "fund" | "cash";
  currency: string;
  quantity: string;
  costEur: string | null;
  valueEur: string | null;
  unrealisedEur: string | null;
  priceDate: string | null;
  stale: boolean;
  costBasisError: { tradeDate: string; message: string } | null;
  valuationError: string | null;
};

export type SortKey = "name" | "quantity" | "costEur" | "valueEur" | "unrealisedEur";
export type SortDirection = "asc" | "desc";

// Finnish alphabetical order places Ä/Ö after Z, not next to A/O -- a plain
// `<` (code-point) comparison gets this wrong, so every name sort goes
// through this collator instead of string comparison operators.
const collator = new Intl.Collator("fi-FI");

/**
 * Returns a new, sorted array; the input is never mutated, so a caller
 * holding a reference to the original `rows` (e.g. React Query's cached
 * data) never sees it reordered out from under it.
 */
export const sortHoldings = (
  rows: readonly Holding[],
  key: SortKey,
  direction: SortDirection,
): Holding[] => {
  const sign = direction === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    if (key === "name") return sign * collator.compare(a.name, b.name);
    // A `null` money field (unknown cost basis) sorts as zero, same treatment
    // as the pre-existing "never priced" case below -- `Number(null)` is `0`.
    return sign * (Number(a[key]) - Number(b[key]));
  });
};
