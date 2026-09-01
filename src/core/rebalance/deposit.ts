import { addMoney, money, zeroMoney, EUR, type Money } from "../money.ts";
import type { DriftRow } from "./drift.ts";
import { BASIS_POINTS, type Target } from "./targets.ts";

export type DepositAllocation = {
  readonly key: string;
  readonly label: string;
  readonly amountEur: Money;
};

/**
 * Where to put money about to be paid in, to close as much of the gap as it can.
 *
 * The default remedy for drift, and the only one that cannot go wrong: it
 * realises no gain, triggers no tax, and moves the portfolio toward its target
 * by construction. Selling to rebalance is a separate thing the owner asks for.
 *
 * The shortfall is measured against the target applied to the total *after* the
 * deposit, not before it. Adding money changes every weight: a slice exactly on
 * target beforehand is underweight once the money lands, and a rule measured on
 * the old total would send nothing there and leave the deposit stuck in
 * whichever slice happened to be furthest behind.
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

  // How far each targeted slice is below where it should be once the money has
  // landed. A slice already at or above that needs none of it.
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

  // More than enough to close every gap: fill them all, then spread what is
  // left by the target weights. Dumping the excess into whichever slice was
  // furthest behind would overshoot it and open a new gap the other way.
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

  // The largest allocation absorbs the rounding remainder, so the parts sum to
  // exactly what was paid in -- a split that loses a cent will not reconcile
  // against the deposit it describes.
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
