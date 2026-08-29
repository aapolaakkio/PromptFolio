import { z } from "zod";

/**
 * The shapes `/api/tax` returns, parsed rather than cast.
 *
 * Every money field is a decimal string, as everywhere else on the wire: a
 * JSON number would round a cent away before this screen ever saw it.
 */
export const TaxDisposalSchema = z.object({
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

export const TaxDividendSchema = z.object({
  instrument: z.string().nullable(),
  accountName: z.string(),
  paidOn: z.string(),
  grossEur: z.string(),
  withheldEur: z.string(),
  taxableEur: z.string(),
  withholdingRecorded: z.boolean(),
});

export const OstWithdrawalSchema = z.object({
  withdrawnOn: z.string(),
  amountEur: z.string(),
  withheldEur: z.string(),
  valueEur: z.string().nullable(),
  profitEur: z.string().nullable(),
  taxableEur: z.string().nullable(),
  blockedBy: z.string().nullable(),
});

export const OstSchema = z.object({
  accountName: z.string(),
  withdrawals: z.array(OstWithdrawalSchema),
  depositedEur: z.string(),
  capRemainingEur: z.string(),
  incomplete: z.boolean(),
});

const CarriedLossSchema = z.object({
  fromYear: z.number(),
  amountEur: z.string(),
});

export const TaxYearSchema = z.object({
  year: z.number(),
  disposals: z.array(TaxDisposalSchema),
  totalSalePriceEur: z.string(),
  exempt: z.boolean(),
  gainsEur: z.string(),
  lossesEur: z.string(),
  netEur: z.string(),
  lossesUsedEur: z.string(),
  lossCarriedIn: z.array(CarriedLossSchema),
  lossCarriedOut: z.array(CarriedLossSchema),
  dividends: z.array(TaxDividendSchema),
  dividendTaxableEur: z.string(),
  ost: z.array(OstSchema),
  source: z.object({
    transactions: z.number(),
    earliest: z.string().nullable(),
  }),
});

export const TaxYearsSchema = z.array(z.number());

export type TaxYearView = z.infer<typeof TaxYearSchema>;
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
