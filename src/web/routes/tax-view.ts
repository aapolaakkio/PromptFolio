import type { getTaxYear } from "../server/tax.ts";
import { z } from "zod";

/**
 * A disposal row's shape. Every money field is a decimal string, as everywhere else on the wire: a
 * JSON number would round a cent away before this screen ever saw it.
 */
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

/**
 * The report's shape, taken from the function that produces it rather than
 * from a schema that describes it. The two used to drift; now a field renamed
 * in the tax module is a type error in this page.
 */
export type TaxYearView = Awaited<ReturnType<typeof getTaxYear>>;
export type TaxDisposalView = z.infer<typeof TaxDisposalSchema>;

/**
 * Which method a disposal was reported under, in Finnish, with the figure the
 * other method would have given.
 *
 * Both are shown because the taxpayer chooses: a screen that printed only the
 * winner would be asking to be trusted on the choice rather than showing it.
 */
export const methodLabel = (row: TaxDisposalView): string =>
  row.method === "deemed"
    ? `hankintameno-olettama ${row.deemedPercent} %`
    : "todellinen hankintameno";
