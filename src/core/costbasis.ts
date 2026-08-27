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
} from "./money";
import type { IsoDate, Txn } from "./types";

export type Lot = {
  readonly instrumentId: number;
  readonly acquiredOn: IsoDate;
  readonly quantity: Quantity;
  readonly costEur: Money;
};

export type Disposal = {
  readonly instrumentId: number;
  readonly acquiredOn: IsoDate;
  readonly soldOn: IsoDate;
  readonly quantity: Quantity;
  readonly proceedsEur: Money;
  readonly costEur: Money;
  readonly gainEur: Money;
};

const chronological = (txns: readonly Txn[]): Txn[] =>
  txns
    .slice()
    .sort((a, b) =>
      a.tradeDate === b.tradeDate ? a.id - b.id : a.tradeDate < b.tradeDate ? -1 : 1,
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

export const buildLots = (txns: readonly Txn[]) => {
  const openByInstrument = new Map<number, Lot[]>();
  const disposals: Disposal[] = [];

  for (const t of chronological(txns)) {
    if (t.instrumentId === null) continue;
    const lots = openByInstrument.get(t.instrumentId) ?? [];

    if (t.type === "BUY" || t.type === "TRANSFER_IN") {
      if (t.amount.minor > 0n) {
        throw new Error(
          `Cannot record ${t.type} of instrument ${t.instrumentId} on ${t.tradeDate}: ` +
            `acquisition amount ${formatMoney(t.amount)} must not be positive (cash in on an acquisition)`,
        );
      }
      const grossEur = toEur(negateMoney(t.amount), t.fxRateEur, "half-up");
      const feeEur = toEur(t.fee, t.fxRateEur, "half-up");
      lots.push({
        instrumentId: t.instrumentId,
        acquiredOn: t.tradeDate,
        quantity: t.quantity,
        costEur: addMoney(grossEur, feeEur),
      });
      openByInstrument.set(t.instrumentId, lots);
      continue;
    }

    if (t.type === "SPLIT") {
      openByInstrument.set(t.instrumentId, rescaleLots(lots, t.quantity));
      continue;
    }

    if (t.type !== "SELL" && t.type !== "TRANSFER_OUT") continue;

    const proceedsEur = subMoney(
      toEur(t.amount, t.fxRateEur, "half-up"),
      toEur(t.fee, t.fxRateEur, "half-up"),
    );
    const held = lots.reduce((sum, lot) => addQuantity(sum, lot.quantity), { scaled: 0n });
    if (cmpQuantity(held, t.quantity) < 0) {
      throw new Error(
        `Cannot dispose ${formatQuantity(t.quantity)} units of instrument ${t.instrumentId} ` +
          `on ${t.tradeDate}: only ${formatQuantity(held)} held`,
      );
    }

    let remainingLots = lots;
    let remaining = t.quantity;
    let remainingProceeds = proceedsEur;
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

      disposals.push({
        instrumentId: t.instrumentId,
        acquiredOn: lot.acquiredOn,
        soldOn: t.tradeDate,
        quantity: taken,
        proceedsEur: shareOfProceeds,
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
    openByInstrument.set(t.instrumentId, remainingLots);
  }

  const open = [...openByInstrument.values()].flat().filter((lot) => lot.quantity.scaled > 0n);
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
