import type { Disposal } from "../costbasis.ts";
import { addMoney, subMoney, type Money, type Quantity } from "../money.ts";
import type { IsoDate } from "../types.ts";
import {
  DEEMED_COST_LONG_PERCENT,
  DEEMED_COST_LONG_YEARS,
  DEEMED_COST_SHORT_PERCENT,
  percentOf,
} from "./rates.ts";

/** Which acquisition cost the disposal is reported with. */
type TaxMethod = "actual" | "deemed";

/** One disposal as on a tax return, computed both permitted ways so the rejected figure stays visible. */
export type TaxableDisposal = {
  readonly accountId: number;
  readonly instrumentId: number;
  readonly acquiredOn: IsoDate;
  readonly soldOn: IsoDate;
  readonly quantity: Quantity;
  /** Fee deducted; the actual-cost base. */
  readonly netProceedsEur: Money;
  /** Net plus fee; the deemed cost is a share of this. */
  readonly grossProceedsEur: Money;
  readonly actualCostEur: Money;
  readonly deemedCostEur: Money;
  readonly deemedPercent: bigint;
  readonly actualGainEur: Money;
  readonly deemedGainEur: Money;
  readonly method: TaxMethod;
  readonly gainEur: Money;
};

/** True on or after the `years`th anniversary of `acquiredOn` (the anniversary itself qualifies). */
const heldAtLeast = (acquiredOn: IsoDate, soldOn: IsoDate, years: number): boolean => {
  const anniversary = new Date(`${acquiredOn}T00:00:00Z`);
  anniversary.setUTCFullYear(anniversary.getUTCFullYear() + years);
  return soldOn >= anniversary.toISOString().slice(0, 10);
};

/**
 * Taxable disposals from `buildLots`. OST disposals are dropped (taxed at withdrawal, not twice).
 * The caller must pass only SELL disposals: `buildLots` also records transfers, which are not sales.
 */
export const taxableDisposals = (args: {
  readonly disposals: readonly Disposal[];
  readonly ostAccountIds: ReadonlySet<number>;
}): TaxableDisposal[] =>
  args.disposals
    .filter((disposal) => !args.ostAccountIds.has(disposal.accountId))
    .map((disposal): TaxableDisposal => {
      const netProceedsEur = disposal.proceedsEur;
      const grossProceedsEur = addMoney(netProceedsEur, disposal.feeEur);
      const deemedPercent = heldAtLeast(
        disposal.acquiredOn,
        disposal.soldOn,
        DEEMED_COST_LONG_YEARS,
      )
        ? DEEMED_COST_LONG_PERCENT
        : DEEMED_COST_SHORT_PERCENT;
      const deemedCostEur = percentOf(grossProceedsEur, deemedPercent);
      const actualGainEur = subMoney(netProceedsEur, disposal.costEur);
      const deemedGainEur = subMoney(grossProceedsEur, deemedCostEur);
      // Deemed cost may only reduce a genuine gain, never enlarge a loss.
      const method: TaxMethod =
        actualGainEur.minor > 0n && deemedGainEur.minor < actualGainEur.minor ? "deemed" : "actual";

      return {
        accountId: disposal.accountId,
        instrumentId: disposal.instrumentId,
        acquiredOn: disposal.acquiredOn,
        soldOn: disposal.soldOn,
        quantity: disposal.quantity,
        netProceedsEur,
        grossProceedsEur,
        actualCostEur: disposal.costEur,
        deemedCostEur,
        deemedPercent,
        actualGainEur,
        deemedGainEur,
        method,
        gainEur: method === "deemed" ? deemedGainEur : actualGainEur,
      };
    });
