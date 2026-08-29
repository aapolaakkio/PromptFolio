import type { Disposal } from "../costbasis";
import { addMoney, subMoney, type Money } from "../money";
import type { IsoDate, Quantity } from "../types";
import {
  DEEMED_COST_LONG_PERCENT,
  DEEMED_COST_LONG_YEARS,
  DEEMED_COST_SHORT_PERCENT,
  percentOf,
} from "./rates";

/** Which acquisition cost the disposal is reported with. */
export type TaxMethod = "actual" | "deemed";

/**
 * One disposal as it appears on a tax return, computed both permitted ways.
 *
 * Both are kept rather than only the winner: the taxpayer chooses, so a report
 * showing one figure is showing the wrong one whenever the other is better, and
 * the choice is only checkable if the rejected figure is visible beside it.
 */
export type TaxableDisposal = {
  readonly accountId: number;
  readonly instrumentId: number;
  readonly acquiredOn: IsoDate;
  readonly soldOn: IsoDate;
  readonly quantity: Quantity;
  /** Fee already deducted -- the base the actual-cost method uses. */
  readonly netProceedsEur: Money;
  /** Net plus the fee -- the sale price the deemed cost is a share of. */
  readonly grossProceedsEur: Money;
  readonly actualCostEur: Money;
  readonly deemedCostEur: Money;
  /** 20n or 40n, by how long the lot was held. */
  readonly deemedPercent: bigint;
  readonly actualGainEur: Money;
  readonly deemedGainEur: Money;
  readonly method: TaxMethod;
  /** The gain under `method` -- what the return reports. */
  readonly gainEur: Money;
};

/**
 * True when `soldOn` falls on or after the `years`th anniversary of
 * `acquiredOn`. Calendar-based, so "at least 10 years" means the anniversary
 * itself qualifies and leap days need no special case.
 */
const heldAtLeast = (acquiredOn: IsoDate, soldOn: IsoDate, years: number): boolean => {
  const anniversary = new Date(`${acquiredOn}T00:00:00Z`);
  anniversary.setUTCFullYear(anniversary.getUTCFullYear() + years);
  return soldOn >= anniversary.toISOString().slice(0, 10);
};

/**
 * Taxable disposals, from the lots `buildLots` matched.
 *
 * Disposals inside an equity savings account are dropped: nothing that happens
 * inside an OST is taxed when it happens, and counting a sale there as well as
 * the eventual withdrawal would tax the same money twice.
 *
 * Transfers are not filtered here -- the caller passes only the disposals that
 * came from a SELL, because moving one's own shares between accounts is not a
 * sale even though `buildLots` records it as a disposal so cost basis can
 * follow the shares.
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
      // The deemed cost is an alternative to the real one, not a way to enlarge
      // a loss: a taxpayer claiming it on a losing sale would be claiming a
      // bigger loss than they suffered. It is therefore only ever taken when it
      // reduces a genuine gain.
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
