import type { AllocationResult } from "../allocation.ts";
import { addMoney, divMoney, money, zeroMoney, EUR, type Money } from "../money.ts";
import { BASIS_POINTS, type Target } from "./targets.ts";

/** Five percentage points: without a band every slice always reads as drifted. Affects only the label, not the figure. */
const DEFAULT_BAND_BP = 500;

export type DriftRow = {
  readonly key: string;
  readonly label: string;
  readonly actualBp: number;
  /** Null when untargeted, which is not the same as a zero target (only that implies selling). */
  readonly targetBp: number | null;
  readonly driftBp: number | null;
  /** Amount to move to correct: positive buys, negative sells. Null when untargeted or the portfolio is incomplete. */
  readonly driftEur: Money | null;
  readonly withinBand: boolean;
  readonly untargeted: boolean;
};

type DriftReport = {
  readonly rows: readonly DriftRow[];
  readonly totalEur: Money;
  /** A holding could not be valued, so the total and every row's gap are unknown. */
  readonly incomplete: boolean;
};

/** A weight (0.6023) as basis points (6023), rounded half-up. */
const toBasisPoints = (weight: number): number => Math.round(weight * BASIS_POINTS);

export const driftFor = (args: {
  readonly allocation: AllocationResult;
  readonly targets: readonly Target[];
  readonly bandBp?: number;
}): DriftReport => {
  const { allocation, targets, bandBp = DEFAULT_BAND_BP } = args;
  const targetByKey = new Map(targets.map((target) => [target.key, target.weightBp]));
  const incomplete = allocation.excludedInstrumentIds.length > 0;
  const totalEur = allocation.slices.reduce(
    (sum, slice) => addMoney(sum, slice.valueEur),
    zeroMoney(EUR),
  );

  const held = allocation.slices.map((slice): DriftRow => {
    const targetBp = targetByKey.get(slice.key) ?? null;
    const actualBp = toBasisPoints(slice.weight);
    const driftBp = targetBp === null ? null : actualBp - targetBp;
    return {
      key: slice.key,
      label: slice.label,
      actualBp,
      targetBp,
      driftBp,
      driftEur:
        driftBp === null || incomplete
          ? null
          : // Negated: signed as the trade (above target means sell).
            divMoney(
              money(BigInt(-driftBp) * totalEur.minor, EUR),
              BigInt(BASIS_POINTS),
              "half-up",
            ),
      withinBand: driftBp !== null && Math.abs(driftBp) <= bandBp,
      untargeted: targetBp === null,
    };
  });

  // A target for something not held is drift too; without it a move into a new asset class shows nothing.
  const missing = targets
    .filter((target) => !allocation.slices.some((slice) => slice.key === target.key))
    .map((target): DriftRow => ({
      key: target.key,
      label: target.key,
      actualBp: 0,
      targetBp: target.weightBp,
      driftBp: -target.weightBp,
      driftEur: incomplete
        ? null
        : divMoney(
            money(BigInt(target.weightBp) * totalEur.minor, EUR),
            BigInt(BASIS_POINTS),
            "half-up",
          ),
      withinBand: target.weightBp <= bandBp,
      untargeted: false,
    }));

  return { rows: [...held, ...missing], totalEur, incomplete };
};
