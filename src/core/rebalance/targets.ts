/** 100 %, in weight units. */
export const BASIS_POINTS = 10_000;

export type Target = { readonly key: string; readonly weightBp: number };

type TargetError = { readonly message: string; readonly totalBp: number };

/** Basis points as a percentage string for messages. */
const asPercent = (bp: number): string => (bp / 100).toFixed(bp % 100 === 0 ? 0 : 2);

/** Null when usable, else why not. A set not summing to 100 % is refused, not normalised: it likely forgot a slice. */
export const checkTargets = (targets: readonly Target[]): TargetError | null => {
  if (targets.length === 0) {
    // No targets is expressed by storing none; an empty set here means a caller lost them.
    return { message: "The target allocation is empty.", totalBp: 0 };
  }

  const negative = targets.find((target) => target.weightBp < 0);
  if (negative !== undefined) {
    return {
      message: `A target cannot be negative: ${negative.key} is ${asPercent(negative.weightBp)} %.`,
      totalBp: targets.reduce((sum, target) => sum + target.weightBp, 0),
    };
  }

  const totalBp = targets.reduce((sum, target) => sum + target.weightBp, 0);
  if (totalBp !== BASIS_POINTS) {
    return {
      message:
        `The targets must add up to 100 %, now ${asPercent(totalBp)} %. ` +
        `Is a line missing, or is one counted twice?`,
      totalBp,
    };
  }
  return null;
};
