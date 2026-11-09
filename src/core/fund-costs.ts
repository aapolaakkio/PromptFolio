import {
  addMoney,
  divMoney,
  EUR,
  formatMoney,
  money,
  parseMoney,
  zeroMoney,
  type Money,
} from "./money.ts";

const BP_PER_UNIT = 10_000n;

/** What `valueEur` costs per year at `bp` basis points (0.20 % is 20), rounded to cents. */
export const yearlyCostEur = (valueEur: Money, bp: number): Money =>
  divMoney(money(valueEur.minor * BigInt(bp), valueEur.currency), BP_PER_UNIT);

type YearlyCostSummary = {
  /** Null when no fee is known: a zero would read as "free". */
  readonly totalEur: string | null;
  readonly known: number;
  readonly total: number;
};

/** Total of the known yearly costs with how many of the funds that covers. */
export const yearlyCostSummary = (
  rows: readonly { readonly yearlyCostEur: string | null }[],
): YearlyCostSummary => {
  const known = rows.flatMap((row) => (row.yearlyCostEur === null ? [] : [row.yearlyCostEur]));
  return {
    totalEur:
      known.length === 0
        ? null
        : formatMoney(
            known.reduce((sum, text) => addMoney(sum, parseMoney(text, EUR)), zeroMoney(EUR)),
          ),
    known: known.length,
    total: rows.length,
  };
};
