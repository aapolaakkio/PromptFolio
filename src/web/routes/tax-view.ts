import type { getTaxYear } from "../server/tax.ts";
import { z } from "zod";

/** A disposal row; money fields are decimal strings, since a JSON number would round a cent away. */
const TaxDisposalSchema = z.object({
  instrument: z.string(),
  isin: z.string(),
  accountName: z.string(),
  acquiredOn: z.string(),
  soldOn: z.string(),
  quantity: z.string(),
  netProceedsEur: z.string(),
  grossProceedsEur: z.string(),
  actualCostEur: z.string(),
  deemedCostEur: z.string(),
  deemedPercent: z.number(),
  actualGainEur: z.string(),
  deemedGainEur: z.string(),
  method: z.enum(["actual", "deemed"]),
  gainEur: z.string(),
});

/** The report's shape, taken from the function that produces it, so a renamed field is a type error here. */
export type TaxYearView = Awaited<ReturnType<typeof getTaxYear>>;
export type TaxDisposalView = z.infer<typeof TaxDisposalSchema>;

/** Which method a disposal was reported under (the taxpayer chooses, so both figures are shown). */
export const methodLabel = (row: TaxDisposalView): string =>
  row.method === "deemed" ? `deemed cost ${row.deemedPercent} %` : "actual cost";
