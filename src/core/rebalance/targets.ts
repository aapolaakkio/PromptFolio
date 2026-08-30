import type { Dimension } from "../allocation.ts";

/** One hundred per cent, in the integer unit weights are stored in. */
export const BASIS_POINTS = 10_000;

export type Target = { readonly key: string; readonly weightBp: number };

export type TargetSet = { readonly dimension: Dimension; readonly targets: readonly Target[] };

export type TargetError = { readonly message: string; readonly totalBp: number };

/** A basis-point weight as a percentage string, for a message a person reads. */
const asPercent = (bp: number): string => (bp / 100).toFixed(bp % 100 === 0 ? 0 : 2);

/**
 * Whether a target set can be used, and if not, why.
 *
 * A set that does not sum to 100 % is refused rather than normalised. Summing
 * to 90 % means a slice was forgotten, and scaling the rest up to cover the
 * missing tenth would hide that behind figures that look deliberate -- the
 * owner would then measure drift against a target they never set.
 *
 * Returns `null` when the set is usable, so a caller reads as
 * `const error = checkTargets(...)` rather than inverting a boolean.
 */
export const checkTargets = (targets: readonly Target[]): TargetError | null => {
  if (targets.length === 0) {
    // Having no targets at all is expressed by storing none. An empty set
    // arriving here is a caller that lost them on the way.
    return { message: "Tavoitejakauma on tyhjä.", totalBp: 0 };
  }

  const negative = targets.find((target) => target.weightBp < 0);
  if (negative !== undefined) {
    return {
      message: `Tavoite ei voi olla negatiivinen: ${negative.key} on ${asPercent(negative.weightBp)} %.`,
      totalBp: targets.reduce((sum, target) => sum + target.weightBp, 0),
    };
  }

  const totalBp = targets.reduce((sum, target) => sum + target.weightBp, 0);
  if (totalBp !== BASIS_POINTS) {
    return {
      message:
        `Tavoitteiden summan on oltava 100 %, nyt ${asPercent(totalBp)} %. ` +
        `Puuttuuko jokin erä, vai onko jokin kahdesti?`,
      totalBp,
    };
  }
  return null;
};
