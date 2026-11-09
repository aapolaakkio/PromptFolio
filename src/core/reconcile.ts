import { parseQuantity, subQuantity, type Quantity } from "./money.ts";
import { positionsAt } from "./ledger.ts";
import type { IsoDate, Txn } from "./types.ts";

/** One line of a broker's holdings statement; compared against the ledger, never turned into transactions. */
export type SnapshotPosition = {
  readonly instrumentId: number;
  readonly quantity: Quantity;
};

export type ReconcileRow = {
  readonly instrumentId: number;
  readonly derived: Quantity;
  readonly snapshot: Quantity;
  /** `snapshot - derived`: positive means the ledger is missing units. */
  readonly delta: Quantity;
  /** Small enough to be rounding: brokers publish fund units to fewer decimals than the ledger stores. */
  readonly withinTolerance: boolean;
  /** Snapshot-only usually means a missing import; ledger-only a sale that never landed. */
  readonly presence: "both" | "snapshot-only" | "ledger-only";
};

// Brokers publish four decimals, the ledger keeps six; half the last published decimal is the max rounding gap.
export const DEFAULT_TOLERANCE: Quantity = parseQuantity("0.00005");

const absScaled = (q: Quantity): bigint => (q.scaled < 0n ? -q.scaled : q.scaled);

const ZERO: Quantity = { scaled: 0n };

/** Compares derived positions on `asOf` with a statement, one row per instrument, sorted by id. Never resolves differences. */
export const reconcile = (
  txns: readonly Txn[],
  snapshot: readonly SnapshotPosition[],
  asOf: IsoDate,
  opts: { readonly tolerance?: Quantity } = {},
): ReconcileRow[] => {
  const tolerance = opts.tolerance ?? DEFAULT_TOLERANCE;
  const derived = positionsAt(txns, asOf);
  const stated = new Map(snapshot.map((row) => [row.instrumentId, row.quantity]));

  const instrumentIds = [...new Set([...derived.keys(), ...stated.keys()])].sort((a, b) => a - b);

  return instrumentIds.map((instrumentId) => {
    const derivedQty = derived.get(instrumentId) ?? ZERO;
    const snapshotQty = stated.get(instrumentId) ?? ZERO;
    const delta = subQuantity(snapshotQty, derivedQty);
    return {
      instrumentId,
      derived: derivedQty,
      snapshot: snapshotQty,
      delta,
      withinTolerance: absScaled(delta) <= absScaled(tolerance),
      presence: !derived.has(instrumentId)
        ? "snapshot-only"
        : !stated.has(instrumentId)
          ? "ledger-only"
          : "both",
    };
  });
};

/** Rows rounding cannot explain. */
export const differences = (rows: readonly ReconcileRow[]): ReconcileRow[] =>
  rows.filter((row) => !row.withinTolerance);
