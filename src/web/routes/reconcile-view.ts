import { z } from "zod";

/** A reconcile row; quantities stay decimal strings to avoid losing precision on fractional fund units. */
const ReconcileRowSchema = z.object({
  instrumentId: z.number(),
  name: z.string().nullable(),
  derived: z.string(),
  snapshot: z.string(),
  delta: z.string(),
  withinTolerance: z.boolean(),
  presence: z.enum(["both", "snapshot-only", "ledger-only"]),
});

export type ReconcileRow = z.infer<typeof ReconcileRowSchema>;

/** A holding the statement lists but the ledger never saw is a missing import; the reverse is usually a sale that never landed. */
export const explain = (row: ReconcileRow): string => {
  if (row.withinTolerance && row.presence === "both") return "Matches";
  if (row.presence === "snapshot-only") {
    return "Only on the statement — an import is missing or the instrument differs";
  }
  if (row.presence === "ledger-only")
    return "Only in the ledger — the sale is missing from the statement";
  return Number(row.delta) > 0 ? "Units missing from the ledger" : "Too many units in the ledger";
};

/** Rows worth a person's attention: everything rounding cannot explain, worst first. */
export const needsAttention = (rows: readonly ReconcileRow[]): ReconcileRow[] =>
  rows
    .filter((row) => !row.withinTolerance)
    .slice()
    .sort((a, b) => Math.abs(Number(b.delta)) - Math.abs(Number(a.delta)));
