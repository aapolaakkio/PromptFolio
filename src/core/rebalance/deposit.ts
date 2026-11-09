import { addMoney, money, zeroMoney, EUR, type Money } from "../money.ts";
import type { DriftRow } from "./drift.ts";
import { BASIS_POINTS, type Target } from "./targets.ts";

type DepositAllocation = {
  readonly key: string;
  readonly label: string;
  readonly amountEur: Money;
};

/**
 * Where to put a coming deposit to close the gap: realises no gain, so the default remedy for drift.
 * Shortfall is measured against the target on the total after the deposit, since the deposit changes every weight.
 */
export const allocateDeposit = (args: {
  readonly rows: readonly DriftRow[];
  readonly targets: readonly Target[];
  readonly totalEur: Money;
  readonly depositEur: Money;
}): readonly DepositAllocation[] => {
  const { rows, targets, totalEur, depositEur } = args;
  if (depositEur.minor <= 0n) return [];

  const after = addMoney(totalEur, depositEur);
  const rowByKey = new Map(rows.map((row) => [row.key, row]));

  // Each targeted slice's gap below target once the money lands.
  const shortfalls = targets
    .map((target) => {
      const row = rowByKey.get(target.key);
      const held = row === undefined ? zeroMoney(EUR) : sliceValue(row, totalEur);
      const wanted = (BigInt(target.weightBp) * after.minor) / BigInt(BASIS_POINTS);
      const short = wanted - held.minor;
      return { key: target.key, label: row?.label ?? target.key, short };
    })
    .filter((entry) => entry.short > 0n);

  const totalShort = shortfalls.reduce((sum, entry) => sum + entry.short, 0n);

  // Surplus: fill every gap, then spread the rest by target weight (not into one slice, which would overshoot).
  const excess = depositEur.minor - totalShort;
  const base =
    excess >= 0n
      ? shortfalls.map((entry) => ({ ...entry, amount: entry.short }))
      : shortfalls.map((entry) => ({
          ...entry,
          amount: (entry.short * depositEur.minor) / totalShort,
        }));

  const spread =
    excess <= 0n
      ? base
      : targets.map((target) => {
          const filled = base.find((entry) => entry.key === target.key);
          const share = (BigInt(target.weightBp) * excess) / BigInt(BASIS_POINTS);
          return {
            key: target.key,
            label: filled?.label ?? rowByKey.get(target.key)?.label ?? target.key,
            short: filled?.short ?? 0n,
            amount: (filled?.amount ?? 0n) + share,
          };
        });

  if (spread.length === 0) return [];

  // The largest allocation absorbs rounding so the parts sum exactly to the deposit.
  const assigned = spread.reduce((sum, entry) => sum + entry.amount, 0n);
  const remainder = depositEur.minor - assigned;
  const largest = spread.reduce(
    (best, entry) => (entry.amount > best.amount ? entry : best),
    spread[0]!,
  );

  return spread
    .map((entry) => ({
      key: entry.key,
      label: entry.label,
      amountEur: money(entry === largest ? entry.amount + remainder : entry.amount, EUR),
    }))
    .filter((allocation) => allocation.amountEur.minor > 0n);
};

/** A row's own value, recovered from its share of the pre-deposit total. */
const sliceValue = (row: DriftRow, totalEur: Money): Money =>
  money((BigInt(row.actualBp) * totalEur.minor) / BigInt(BASIS_POINTS), EUR);
