import { z } from "zod";

import { MAX_FORECAST_MONTHS } from "../../core/forecast.ts";

export const MAX_OVERRIDE_EUR = 10_000_000;
const MAX_EVENTS = 20;
const MAX_ROWS = 50;

const Month = z.number().int().min(1).max(MAX_FORECAST_MONTHS);
const InstrumentId = z.number().int().positive();
const Rate = z.number().min(-0.9).max(1);

/** Changes to the owner's own forecast; every instrument id is checked against that forecast's holdings. */
const overrides = {
  months: Month.optional(),
  real: z.boolean().optional(),
  holdingIds: z.array(InstrumentId).min(1).max(200).optional(),
  plan: z
    .array(
      z
        .object({
          instrumentId: InstrumentId,
          monthlyEur: z.number().min(0).max(MAX_OVERRIDE_EUR),
          fromMonth: Month.optional(),
          toMonth: Month.optional(),
          yearlyIncrease: z.number().min(-0.5).max(1).optional(),
        })
        .strict()
        .refine(
          (row) =>
            row.fromMonth === undefined ||
            row.toMonth === undefined ||
            row.toMonth >= row.fromMonth,
          { message: "toMonth must not be before fromMonth", path: ["toMonth"] },
        ),
    )
    .max(MAX_ROWS)
    .optional(),
  monthlyTotalEur: z.number().min(0).max(MAX_OVERRIDE_EUR).optional(),
  events: z
    .array(
      z
        .object({
          month: Month,
          instrumentId: InstrumentId.optional(),
          amountEur: z.number().min(-MAX_OVERRIDE_EUR).max(MAX_OVERRIDE_EUR),
        })
        .strict(),
    )
    .max(MAX_EVENTS)
    .optional(),
  shocks: z
    .array(
      z
        .object({
          month: Month,
          instrumentId: InstrumentId.optional(),
          change: z.number().min(-1).max(1),
        })
        .strict(),
    )
    .max(MAX_EVENTS)
    .optional(),
  rates: z
    .array(
      z.object({ instrumentId: z.union([InstrumentId, z.literal("all")]), rate: Rate }).strict(),
    )
    .max(MAX_ROWS)
    .optional(),
};

const onePlanChange = (input: { plan?: unknown; monthlyTotalEur?: unknown }): boolean =>
  input.plan === undefined || input.monthlyTotalEur === undefined;
const ONE_PLAN_CHANGE = "Give either plan rows or monthlyTotalEur, not both";

export const RunForecastInput = z.object(overrides).strict().refine(onePlanChange, ONE_PLAN_CHANGE);

export const ForecastTargetInput = z
  .object({
    ...overrides,
    targetEur: z.number().positive().max(MAX_OVERRIDE_EUR),
    byMonth: z
      .number()
      .int()
      .min(1, `byMonth must be between 1 and ${MAX_FORECAST_MONTHS}`)
      .max(MAX_FORECAST_MONTHS, `byMonth must be between 1 and ${MAX_FORECAST_MONTHS}`)
      .optional(),
  })
  .strict()
  .refine(onePlanChange, ONE_PLAN_CHANGE);

export type ForecastOverrides = z.infer<typeof RunForecastInput>;
