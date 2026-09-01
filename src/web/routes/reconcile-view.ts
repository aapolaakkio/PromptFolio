import { z } from "zod";

/**
 * A reconcile row's shape. Quantities arrive as decimal strings and stay strings: this screen only displays them,
 * and turning a fractional fund unit into a JavaScript number to render it is
 * how precision gets lost at the last possible moment.
 */
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

/**
 * What a row means in words, because a bare delta does not say what to do about
 * it. A holding the statement lists and the ledger has never seen is a missing
 * import; the reverse is usually a sale that never landed. Neither is a
 * miscount, and telling them apart is most of the value of this screen.
 */
export const explain = (row: ReconcileRow): string => {
  if (row.withinTolerance && row.presence === "both") return "Täsmää";
  if (row.presence === "snapshot-only") {
    return "Vain otteella — tuonti puuttuu tai arvopaperi on eri";
  }
  if (row.presence === "ledger-only") return "Vain kirjanpidossa — myynti puuttuu otteelta";
  return Number(row.delta) > 0 ? "Kirjanpidosta puuttuu osuuksia" : "Kirjanpidossa liikaa osuuksia";
};

/** Rows worth a person's attention: everything rounding cannot explain, worst first. */
export const needsAttention = (rows: readonly ReconcileRow[]): ReconcileRow[] =>
  rows
    .filter((row) => !row.withinTolerance)
    .slice()
    .sort((a, b) => Math.abs(Number(b.delta)) - Math.abs(Number(a.delta)));
