import type { AllocationResult } from "../allocation";
import { addMoney, divMoney, money, zeroMoney, EUR, type Money } from "../money";
import { BASIS_POINTS, type Target } from "./targets";

/**
 * How far a slice may sit from its target before the screen calls it drifted.
 *
 * Five percentage points. Without a band every slice is drifted by some amount
 * at all times, and a screen that always says "drifted" teaches the reader to
 * stop looking. The band decides only how the figure reads -- the figure itself
 * is always reported.
 */
export const DEFAULT_BAND_BP = 500;

export type DriftRow = {
  readonly key: string;
  readonly label: string;
  readonly actualBp: number;
  /**
   * Null when this slice has no target. Untargeted is not targeted at zero:
   * "I have not decided about this holding" and "I want none of it" are
   * different statements, and only the second implies selling it.
   */
  readonly targetBp: number | null;
  readonly driftBp: number | null;
  /**
   * What would have to move to correct it: positive to buy, negative to sell.
   * Null when the slice is untargeted, or when the portfolio holds something
   * that could not be valued.
   */
  readonly driftEur: Money | null;
  readonly withinBand: boolean;
  readonly untargeted: boolean;
};

export type DriftReport = {
  readonly rows: readonly DriftRow[];
  readonly totalEur: Money;
  /**
   * True when a holding could not be valued, so every row's gap is unknown --
   * not merely the row that holds it. A weight is a share of a total, and an
   * unknown total makes every share wrong by an unknown amount.
   */
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
          : // Negated: a slice above its target needs money taken out, and the
            // figure a reader acts on is "how much to move", signed the way the
            // trade is.
            divMoney(
              money(BigInt(-driftBp) * totalEur.minor, EUR),
              BigInt(BASIS_POINTS),
              "half-up",
            ),
      withinBand: driftBp !== null && Math.abs(driftBp) <= bandBp,
      untargeted: targetBp === null,
    };
  });

  /**
   * A target for something the portfolio does not hold at all is still drift --
   * the largest kind there is, since the whole target is missing. Without this
   * a plan to move into a new asset class would show nothing to do.
   */
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
