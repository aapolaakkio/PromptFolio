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

/** Total of the known yearly costs; an unknown fee adds nothing. */
export const sumYearlyCosts = (
  rows: readonly { readonly yearlyCostEur: string | null }[],
): string =>
  formatMoney(
    rows.reduce(
      (sum, row) =>
        row.yearlyCostEur === null ? sum : addMoney(sum, parseMoney(row.yearlyCostEur, EUR)),
      zeroMoney(EUR),
    ),
  );
