import {
  addMoney,
  addQuantity,
  cmpQuantity,
  divMoney,
  EUR,
  formatMoney,
  formatQuantity,
  money,
  negateMoney,
  subMoney,
  subQuantity,
  toEur,
  zeroMoney,
  type Money,
  type Quantity,
} from "./money.ts";
import type { IsoDate, Txn } from "./types.ts";

export type Lot = {
  readonly accountId: number;
  readonly instrumentId: number;
  readonly acquiredOn: IsoDate;
  readonly quantity: Quantity;
  readonly costEur: Money;
};

export type Disposal = {
  readonly accountId: number;
  readonly instrumentId: number;
  readonly acquiredOn: IsoDate;
  readonly soldOn: IsoDate;
  readonly quantity: Quantity;
  /** Net of the sale's fee, which `Txn.amount` has already deducted. */
  readonly proceedsEur: Money;
  /**
   * This lot's share of the sale's fee, pro-rated like the proceeds. Carried
   * because the two Finnish methods do not share a base: the deemed cost is a
   * percentage of the gross price with selling costs not deductible on top,
   * while the actual-cost method does deduct them.
   */
  readonly feeEur: Money;
  readonly costEur: Money;
  readonly gainEur: Money;
};

/**
 * A disposal of more units than the ledger records as acquired: incomplete or
 * out-of-order import data, not a bug here. Its own subclass so a caller can
 * check the type rather than match on wording that will change.
 *
 * Carries only the instrument and the date -- what the server needs to name the
 * offending row. The message keeps the quantities for a log, never for a client.
 */
export class UnmatchedDisposalError extends Error {
  // Assigned in the body rather than declared as a parameter property: that
  // is TypeScript syntax Node cannot strip, only transform, and this runs
  // under plain Node in test child processes.
  readonly instrumentId: number;
  readonly tradeDate: IsoDate;

  constructor(
    instrumentId: number,
    tradeDate: IsoDate,
    heldQuantity: Quantity,
    requestedQuantity: Quantity,
  ) {
    super(
      `Cannot dispose ${formatQuantity(requestedQuantity)} units of instrument ${instrumentId} ` +
        `on ${tradeDate}: only ${formatQuantity(heldQuantity)} held`,
    );
    this.instrumentId = instrumentId;
    this.tradeDate = tradeDate;
    this.name = "UnmatchedDisposalError";
  }
}

/**
 * A swap's two legs share a date and brokers disagree on which they print first.
 * The departing leg must be seen first: it releases the basis the arriving leg
 * inherits. Nothing else is reordered.
 */
const transferRank = (type: Txn["type"]): number =>
  type === "TRANSFER_OUT" ? 0 : type === "TRANSFER_IN" ? 2 : 1;

const chronological = (txns: readonly Txn[]): Txn[] =>
  txns
    .slice()
    .sort((a, b) =>
      a.tradeDate !== b.tradeDate
        ? a.tradeDate < b.tradeDate
          ? -1
          : 1
        : transferRank(a.type) !== transferRank(b.type)
          ? transferRank(a.type) - transferRank(b.type)
          : a.id - b.id,
    );

/**
 * Prorates `whole` by `numerator / denominator`, rounding half-up. Callers that split a
 * whole into several parts must give the *final* part the exact remainder instead of
 * calling this for it, so the parts always sum back to the whole regardless of rounding.
 */
const proRata = (whole: Money, numerator: bigint, denominator: bigint): Money =>
  divMoney(money(whole.minor * numerator, whole.currency), denominator, "half-up");

/**
 * Rescales `lots` so their quantities sum exactly to `newTotal`, preserving each lot's
 * proportional share of the pre-split total. Every lot but the last gets its (necessarily
 * rounded-down, since quantities are positive) proportional share; the last lot absorbs
 * whatever remainder that rounding left behind, so the split's total is always exact
 * rather than a byproduct of accumulated rounding.
 */
const rescaleLots = (lots: readonly Lot[], newTotal: Quantity): Lot[] => {
  const oldTotal = lots.reduce((sum, lot) => addQuantity(sum, lot.quantity), { scaled: 0n });
  if (oldTotal.scaled === 0n) return lots.slice();

  let allocated = 0n;
  return lots.map((lot, index) => {
    const scaled =
      index === lots.length - 1
        ? newTotal.scaled - allocated
        : (lot.quantity.scaled * newTotal.scaled) / oldTotal.scaled;
    allocated += scaled;
    return { ...lot, quantity: { scaled } };
  });
};

/**
 * Lots belong to an account, not merely to an instrument. vero.fi states the
 * matching rule as FIFO *within one account*, so the same share held in two
 * accounts has two independent queues -- pooling them is a different rule that
 * only happens to agree while an instrument is held in one account alone.
 */
const lotKey = (accountId: number, instrumentId: number): string => `${accountId}:${instrumentId}`;

export const buildLots = (txns: readonly Txn[]) => {
  const openByAccountInstrument = new Map<string, Lot[]>();
  const disposals: Disposal[] = [];
  /**
   * The lots a departing leg gave up, waiting for the arriving one, by date.
   *
   * A swap moves a holding with no money changing hands, so the arriving leg's
   * amount is zero and cost derived from it would report the whole value as gain.
   * The basis is carried across instead, which is what a swap means: the shares
   * change form, not value.
   *
   * Whole lots, not one merged total, because a swap does not restart ownership.
   * Merging lost each lot's acquisition date and its own cost, so a fractional
   * cash-out days later took cost pro-rata instead of from the oldest lot.
   */
  const carriedLots = new Map<IsoDate, Lot[][]>();

  for (const t of chronological(txns)) {
    if (t.instrumentId === null) continue;
    const instrumentId = t.instrumentId;
    const key = lotKey(t.accountId, instrumentId);
    const lots = openByAccountInstrument.get(key) ?? [];

    if (t.type === "BUY" || t.type === "TRANSFER_IN") {
      if (t.amount.minor > 0n) {
        throw new Error(
          `Cannot record ${t.type} of instrument ${t.instrumentId} on ${t.tradeDate}: ` +
            `acquisition amount ${formatMoney(t.amount)} must not be positive (cash in on an acquisition)`,
        );
      }
      // `t.amount` is already fee-inclusive (see `Txn.amount`'s doc): the fee was
      // already debited as part of the cash that left the account, so the full
      // cost basis is `-amount` alone -- adding `t.fee` again would double-count
      // it (C2).
      const stated = toEur(negateMoney(t.amount), t.fxRateEur, "half-up");
      const waiting = t.type === "TRANSFER_IN" ? carriedLots.get(t.tradeDate) : undefined;
      const carried = waiting?.[0];
      const carriedCost = (carried ?? []).reduce(
        (sum, lot) => addMoney(sum, lot.costEur),
        zeroMoney(EUR),
      );
      // The carried lots are used when the arriving row states no value of its
      // own (OP), and also when it states exactly what the departing leg gave
      // up (Nordnet) -- same total, but split by acquisition date rather than
      // merged. A stated value that disagrees with the carried total describes
      // something other than a plain swap, so it is taken at its word and the
      // lots are left alone.
      const useCarried =
        carried !== undefined &&
        carried.length > 0 &&
        (stated.minor === 0n || stated.minor === carriedCost.minor);

      if (useCarried) {
        waiting?.shift();
        for (const lot of rescaleLots(carried, t.quantity)) {
          lots.push({
            accountId: t.accountId,
            instrumentId: t.instrumentId,
            acquiredOn: lot.acquiredOn,
            quantity: lot.quantity,
            costEur: lot.costEur,
          });
        }
      } else {
        lots.push({
          accountId: t.accountId,
          instrumentId: t.instrumentId,
          acquiredOn: t.tradeDate,
          quantity: t.quantity,
          costEur: stated,
        });
      }
      openByAccountInstrument.set(key, lots);
      continue;
    }

    if (t.type === "SPLIT") {
      openByAccountInstrument.set(key, rescaleLots(lots, t.quantity));
      continue;
    }

    if (t.type !== "SELL" && t.type !== "TRANSFER_OUT") continue;

    // `t.amount` is already fee-inclusive (see `Txn.amount`'s doc): the fee was
    // already deducted from the cash credited to the account, so `amount` alone
    // is the real net proceeds -- subtracting `t.fee` again would double-count
    // it (C2).
    const disposalsBefore = disposals.length;
    const proceedsEur = toEur(t.amount, t.fxRateEur, "half-up");
    const feeEur = toEur(t.fee, t.fxRateEur, "half-up");
    const held = lots.reduce((sum, lot) => addQuantity(sum, lot.quantity), { scaled: 0n });
    if (cmpQuantity(held, t.quantity) < 0) {
      throw new UnmatchedDisposalError(t.instrumentId, t.tradeDate, held, t.quantity);
    }

    let remainingLots = lots;
    let remaining = t.quantity;
    let remainingProceeds = proceedsEur;
    let remainingFee = feeEur;
    while (remaining.scaled > 0n) {
      const lot = remainingLots[0]!;
      const takenScaled =
        lot.quantity.scaled <= remaining.scaled ? lot.quantity.scaled : remaining.scaled;
      const taken: Quantity = { scaled: takenScaled };
      const isFullLot = takenScaled === lot.quantity.scaled;
      const isFinalShare = takenScaled === remaining.scaled;

      const costEur = isFullLot
        ? lot.costEur
        : proRata(lot.costEur, takenScaled, lot.quantity.scaled);
      const shareOfProceeds = isFinalShare
        ? remainingProceeds
        : proRata(proceedsEur, takenScaled, t.quantity.scaled);
      remainingProceeds = subMoney(remainingProceeds, shareOfProceeds);
      // Split the same way as the proceeds, last lot absorbing the remainder,
      // so the parts sum to the fee actually charged rather than losing a cent.
      const shareOfFee = isFinalShare
        ? remainingFee
        : proRata(feeEur, takenScaled, t.quantity.scaled);
      remainingFee = subMoney(remainingFee, shareOfFee);

      disposals.push({
        accountId: t.accountId,
        instrumentId: t.instrumentId,
        acquiredOn: lot.acquiredOn,
        soldOn: t.tradeDate,
        quantity: taken,
        proceedsEur: shareOfProceeds,
        feeEur: shareOfFee,
        costEur,
        gainEur: subMoney(shareOfProceeds, costEur),
      });

      const rest = remainingLots.slice(1);
      remainingLots = isFullLot
        ? rest
        : [
            {
              ...lot,
              quantity: subQuantity(lot.quantity, taken),
              costEur: subMoney(lot.costEur, costEur),
            },
            ...rest,
          ];
      remaining = subQuantity(remaining, taken);
    }
    openByAccountInstrument.set(key, remainingLots);

    if (t.type === "TRANSFER_OUT") {
      // Narrowed at the top of the loop; named here because the closure below
      // does not carry the narrowing.
      const departingId = instrumentId;
      const released = disposals.slice(disposalsBefore).map((disposal): Lot => ({
        accountId: t.accountId,
        instrumentId: departingId,
        acquiredOn: disposal.acquiredOn,
        quantity: disposal.quantity,
        costEur: disposal.costEur,
      }));
      const queue = carriedLots.get(t.tradeDate) ?? [];
      queue.push(released);
      carriedLots.set(t.tradeDate, queue);
    }
  }

  const open = [...openByAccountInstrument.values()]
    .flat()
    .filter((lot) => lot.quantity.scaled > 0n);
  return { open, disposals };
};

export const costBasisAt = (txns: readonly Txn[], on: IsoDate): Map<number, Money> => {
  const { open } = buildLots(txns.filter((t) => t.tradeDate <= on));
  const totals = new Map<number, Money>();
  for (const lot of open) {
    totals.set(
      lot.instrumentId,
      addMoney(totals.get(lot.instrumentId) ?? zeroMoney(EUR), lot.costEur),
    );
  }
  return totals;
};

/** One instrument's cost-basis outcome: either a total, or the disposal that could not be matched. */
export type CostBasisOutcome =
  | { readonly ok: true; readonly costEur: Money }
  | { readonly ok: false; readonly error: UnmatchedDisposalError };

/**
 * Each instrument's lots resolved independently, so one unmatched disposal marks
 * only its own holding unknown instead of taking the whole request down.
 *
 * Safe because lot-building never consults another instrument's transactions, so
 * one instrument in isolation produces exactly the lots it would in the whole.
 */
export const costBasisPerInstrument = (
  txns: readonly Txn[],
  on: IsoDate,
): Map<number, CostBasisOutcome> => {
  const instrumentIds = new Set<number>();
  for (const t of txns) if (t.instrumentId !== null) instrumentIds.add(t.instrumentId);

  const outcomes = new Map<number, CostBasisOutcome>();
  for (const instrumentId of instrumentIds) {
    const own = txns.filter((t) => t.instrumentId === instrumentId);
    try {
      const totals = costBasisAt(own, on);
      outcomes.set(instrumentId, {
        ok: true,
        costEur: totals.get(instrumentId) ?? zeroMoney(EUR),
      });
    } catch (cause) {
      if (!(cause instanceof UnmatchedDisposalError)) throw cause;
      outcomes.set(instrumentId, { ok: false, error: cause });
    }
  }
  return outcomes;
};
