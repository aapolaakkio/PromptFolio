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

type Lot = {
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
  /** Pro-rated share of the sale fee: the deemed cost is on the gross price, actual-cost deducts selling costs. */
  readonly feeEur: Money;
  readonly costEur: Money;
  readonly gainEur: Money;
};

/** Disposal of more units than acquired (bad import data). The message has quantities: log only, never send to a client. */
export class UnmatchedDisposalError extends Error {
  // No parameter properties: Node cannot strip them and this runs under plain Node.
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

// A swap's legs share a date; the departing leg must come first to release the basis.
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

/** Half-up pro-rata. Callers splitting a whole give the final part the exact remainder. */
const proRata = (whole: Money, numerator: bigint, denominator: bigint): Money =>
  divMoney(money(whole.minor * numerator, whole.currency), denominator, "half-up");

/** Rescales lots proportionally to sum exactly to `newTotal`; the last lot absorbs the rounding. */
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

// vero.fi: FIFO within one account, so each account has its own queue per instrument.
const lotKey = (accountId: number, instrumentId: number): string => `${accountId}:${instrumentId}`;

export const buildLots = (txns: readonly Txn[]) => {
  const openByAccountInstrument = new Map<string, Lot[]>();
  const disposals: Disposal[] = [];
  // Lots a departing swap leg gave up, awaiting the arriving leg, by date. A swap moves no money,
  // so basis carries over; kept as whole lots to preserve acquisition dates and per-lot cost.
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
      // `amount` is already fee-inclusive; adding `fee` would double-count.
      const stated = toEur(negateMoney(t.amount), t.fxRateEur, "half-up");
      const waiting = t.type === "TRANSFER_IN" ? carriedLots.get(t.tradeDate) : undefined;
      const carried = waiting?.[0];
      const carriedCost = (carried ?? []).reduce(
        (sum, lot) => addMoney(sum, lot.costEur),
        zeroMoney(EUR),
      );
      // Use carried lots when the row states no value (OP) or exactly the carried total (Nordnet);
      // any other stated value is not a plain swap and is taken at its word.
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

    // `amount` is already net of the fee; subtracting `fee` would double-count.
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
      // Named because the closure below loses the narrowing.
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

/** Resolves each instrument alone, so one unmatched disposal marks only its own holding unknown. */
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
