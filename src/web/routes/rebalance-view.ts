import type { TargetView } from "../../server/rebalance.ts";

/**
 * What the targets being edited add up to, in percent, as a decimal string.
 *
 * Computed on the typed text rather than on parsed numbers so the running total
 * shown while editing is the total of what is actually on screen -- including a
 * half-typed "6" that will become "60".
 */
export const targetTotal = (targets: readonly TargetView[]): string =>
  targets
    .reduce(
      (sum, target) =>
        sum + Math.round(Number(target.weightPercent.replace(",", ".") || "0") * 100),
      0,
    )
    .toString()
    .replace(/(\d*)(\d\d)$/, (_match, whole: string, cents: string) => `${whole || "0"}.${cents}`);
