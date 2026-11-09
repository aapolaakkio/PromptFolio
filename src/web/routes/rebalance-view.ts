import type { TargetView } from "../../server/rebalance.ts";

/** The target total in percent, computed on the typed text so it matches the screen (including a half-typed "6"). */
export const targetTotal = (targets: readonly TargetView[]): string =>
  targets
    .reduce(
      (sum, target) =>
        sum + Math.round(Number(target.weightPercent.replace(",", ".") || "0") * 100),
      0,
    )
    .toString()
    .replace(/(\d*)(\d\d)$/, (_match, whole: string, cents: string) => `${whole || "0"}.${cents}`);
