import { parseQuantity } from "../../core/money.ts";

export type ActionProblem = {
  readonly line: number;
  readonly message: string;
  readonly raw: Readonly<Record<string, string>>;
  readonly ignored?: boolean;
};

/** The only types an action books: it moves units, never cash. */
export const UNIT_TYPES = ["TRANSFER_OUT", "TRANSFER_IN", "SPLIT"] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

const REMOVES = /(?<![\p{L}\d])otto(?![\p{L}\d])/iu;
const ADDS = /(?<![\p{L}\d])(jättö|jatto)(?![\p{L}\d])/iu;

export const labelOf = (row: ActionProblem): string => row.raw.type ?? "";

/** The quantity the recipe read off the row, scaled; null when it prints none. */
export const quantityOf = (row: ActionProblem): bigint | null => {
  try {
    const scaled = parseQuantity(row.raw.quantity ?? "").scaled;
    return scaled === 0n ? null : scaled;
  } catch {
    return null;
  }
};

/** A negative quantity only leaves. Nordnet prints an OTTO's quantity unsigned, so a positive row leaves only when its label says OTTO. */
export const allowedTypes = (row: ActionProblem): readonly UnitType[] => {
  const quantity = quantityOf(row);
  if (quantity === null) return [];
  const label = labelOf(row);
  if (quantity < 0n) return ADDS.test(label) ? [] : ["TRANSFER_OUT"];
  return REMOVES.test(label) ? ["TRANSFER_OUT"] : ["TRANSFER_IN", "SPLIT"];
};

export const isOutLeg = (row: ActionProblem): boolean => allowedTypes(row).includes("TRANSFER_OUT");
const isLeg = (row: ActionProblem): boolean => allowedTypes(row).length > 0;

/** The instrument a row moves: ISIN, or the name where the broker prints no ISIN (OP). */
export const instrumentOf = (row: ActionProblem): string =>
  row.raw.isin || row.raw.instrumentName || `line ${row.line}`;

const byInstrument = (rows: readonly ActionProblem[]): ActionProblem[][] => {
  const buckets = new Map<string, ActionProblem[]>();
  for (const row of rows)
    buckets.set(instrumentOf(row), [...(buckets.get(instrumentOf(row)) ?? []), row]);
  return [...buckets.values()];
};

/**
 * One day's rows as actions. Legs out and in of one instrument are a split. Across instruments, one
 * instrument leaving and others arriving is one swap or merger; with two or more leaving, which
 * arrival belongs to which cannot be told, so none of them is sent.
 */
const actionsOn = (rows: readonly ActionProblem[]): ActionProblem[][] => {
  const buckets = byInstrument(rows.filter(isLeg));
  const splits = buckets.filter((b) => b.some(isOutLeg) && b.some((r) => !isOutLeg(r)));
  const rest = buckets.filter((b) => !splits.includes(b));
  const leaving = rest.filter((b) => b.some(isOutLeg));
  const arriving = rest.filter((b) => !b.some(isOutLeg));
  if (leaving.length === 1 && arriving.length > 0)
    return [...splits, [...leaving.flat(), ...arriving.flat()]];
  if (leaving.length > 1 && arriving.length > 0) return splits;
  return [...splits, ...rest];
};

const firstLine = (group: readonly ActionProblem[]): number =>
  Math.min(...group.map((row) => row.line));

export const actionGroups = (rows: readonly ActionProblem[], max: number): ActionProblem[][] => {
  const byDate = new Map<string, ActionProblem[]>();
  for (const row of rows) {
    const key = row.raw.tradeDate ?? `line ${row.line}`;
    byDate.set(key, [...(byDate.get(key) ?? []), row]);
  }
  return [...byDate.values()]
    .flatMap(actionsOn)
    .map((group) => [...group].sort((a, b) => a.line - b.line))
    .sort((a, b) => firstLine(a) - firstLine(b))
    .slice(0, max);
};

/** What booking a whole action needs: every leg booked, except the leg out of a split's own instrument. */
export const isComplete = (
  group: readonly ActionProblem[],
  booked: ReadonlyMap<number, UnitType>,
): boolean => {
  const splitInstruments = new Set(
    group.filter((row) => booked.get(row.line) === "SPLIT").map(instrumentOf),
  );
  // A SPLIT sets the new total, so any other booking of its instrument would count twice.
  const splitStandsAlone = [...splitInstruments].every((instrument) => {
    const rows = group.filter((row) => instrumentOf(row) === instrument);
    const bookedHere = rows.filter((row) => booked.has(row.line)).length;
    return bookedHere === 1 && rows.some((row) => isOutLeg(row) && !booked.has(row.line));
  });
  const legsBooked = group
    .filter(isLeg)
    .every(
      (row) => booked.has(row.line) || (isOutLeg(row) && splitInstruments.has(instrumentOf(row))),
    );
  return splitStandsAlone && legsBooked;
};

/** A split's unbooked out-legs: the owner's table drops them when the action is applied. */
export const skippedLegs = (
  group: readonly ActionProblem[],
  booked: ReadonlyMap<number, UnitType>,
): number[] => {
  const splitInstruments = new Set(
    group.filter((row) => booked.get(row.line) === "SPLIT").map(instrumentOf),
  );
  return group
    .filter(
      (row) => !booked.has(row.line) && isOutLeg(row) && splitInstruments.has(instrumentOf(row)),
    )
    .map((row) => row.line);
};
