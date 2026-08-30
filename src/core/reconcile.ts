import { parseQuantity, subQuantity, type Quantity } from "./money.ts";
import { positionsAt } from "./ledger.ts";
import type { IsoDate, Txn } from "./types.ts";

/**
 * One instrument's line in a broker's holdings statement: what they say you
 * held. A statement is never turned into transactions -- it is compared against
 * what the ledger derives, and the user decides what to do about any
 * difference. See the spec's §5.2/§5.4: the worst a misread statement can do is
 * show a difference that gets dismissed.
 */
export type SnapshotPosition = {
  readonly instrumentId: number;
  readonly quantity: Quantity;
};

export type ReconcileRow = {
  readonly instrumentId: number;
  /** What the ledger's own transactions add up to on the statement's date. */
  readonly derived: Quantity;
  /** What the broker's statement says. */
  readonly snapshot: Quantity;
  /** `snapshot - derived`: positive means the ledger is missing units. */
  readonly delta: Quantity;
  /**
   * True when the difference is small enough to be rounding rather than a
   * missing transaction. Brokers publish fractional fund units to fewer
   * decimals than this ledger stores, so an exact match is the exception for
   * funds, not the rule.
   */
  readonly withinTolerance: boolean;
  /**
   * Which side knows about this instrument at all. A holding the statement
   * lists and the ledger has never seen usually means a missing import; one the
   * ledger holds and the statement omits usually means a sale that never
   * landed. Both are worth telling apart from an ordinary quantity difference.
   */
  readonly presence: "both" | "snapshot-only" | "ledger-only";
};

/**
 * Brokers publish fund quantities to four decimals where this ledger keeps six,
 * so a holding that agrees exactly to the fourth decimal can still differ in the
 * fifth and sixth. Half of the last published decimal is the largest difference
 * pure rounding can produce.
 */
export const DEFAULT_TOLERANCE: Quantity = parseQuantity("0.00005");

const absScaled = (q: Quantity): bigint => (q.scaled < 0n ? -q.scaled : q.scaled);

const ZERO: Quantity = { scaled: 0n };

/**
 * Compares the positions the ledger derives on `asOf` against a broker's
 * holdings statement for the same date, one row per instrument either side
 * knows about.
 *
 * Reports differences; never resolves them. Whether a row becomes an adjusting
 * transaction or is dismissed is the user's decision -- an importer that
 * silently reconciled itself to a statement would quietly overwrite the
 * transaction history it is supposed to be checked against.
 *
 * Rows come back sorted by instrument id so a caller renders them in a stable
 * order rather than one that depends on map iteration.
 */
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

/** The rows a user actually has to look at: everything a rounding difference cannot explain. */
export const differences = (rows: readonly ReconcileRow[]): ReconcileRow[] =>
  rows.filter((row) => !row.withinTolerance);
