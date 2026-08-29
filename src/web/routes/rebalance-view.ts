import { z } from "zod";

/**
 * The shapes the rebalancing routes return, parsed rather than cast.
 *
 * Every money field is a decimal string and every percentage likewise: a JSON
 * number would round a cent, or a basis point, away before this screen saw it.
 */
export const TargetSchema = z.object({ key: z.string(), weightPercent: z.string() });

export const DriftRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  actualPercent: z.string(),
  targetPercent: z.string().nullable(),
  driftPercent: z.string().nullable(),
  driftEur: z.string().nullable(),
  withinBand: z.boolean(),
  untargeted: z.boolean(),
});

export const DriftSchema = z.object({
  dimension: z.enum(["kind", "currency", "account", "instrument"]),
  rows: z.array(DriftRowSchema),
  totalEur: z.string(),
  incomplete: z.boolean(),
});

export const DepositSchema = z.array(
  z.object({ key: z.string(), label: z.string(), amountEur: z.string() }),
);

const TradeSchema = z.object({
  key: z.string(),
  label: z.string(),
  side: z.enum(["buy", "sell"]),
  amountEur: z.string(),
  realisedGainEur: z.string().nullable(),
  gainUnknown: z.boolean(),
});

export const PlanSchema = z.object({
  trades: z.array(TradeSchema),
  tooSmall: z.array(TradeSchema),
  totalRealisedGainEur: z.string(),
  gainIncomplete: z.boolean(),
  balanced: z.boolean(),
});

export const FeesSchema = z.array(
  z.object({
    year: z.number(),
    tradeFeesEur: z.string(),
    chargedFeesEur: z.string(),
    totalEur: z.string(),
    withheldTaxEur: z.string(),
  }),
);

export const TargetsSchema = z.array(TargetSchema);

/** What PUT /api/targets answers with -- not the targets themselves. */
export const SaveResultSchema = z.object({ saved: z.number() });

export type DriftView = z.infer<typeof DriftSchema>;
export type DriftRowView = z.infer<typeof DriftRowSchema>;
export type PlanView = z.infer<typeof PlanSchema>;
export type TargetView = z.infer<typeof TargetSchema>;

/**
 * What the targets being edited add up to, in percent, as a decimal string.
 *
 * Computed on the typed text rather than on parsed numbers so the running total
 * shown while editing is the total of what is actually on screen -- including a
 * half-typed "6" that will become "60".
 */
export const targetTotal = (targets: readonly TargetView[]): string =>
  targets
    .reduce(
      (sum, target) =>
        sum + Math.round(Number(target.weightPercent.replace(",", ".") || "0") * 100),
      0,
    )
    .toString()
    .replace(/(\d*)(\d\d)$/, (_match, whole: string, cents: string) => `${whole || "0"}.${cents}`);
