import { z } from "zod";

import { MAX_FORECAST_MONTHS } from "../core/forecast.ts";

// Forecast schemas, shared by the server functions, the chat tools and the browser: no server-only imports here.

const MAX_RATE_PERCENT = 50;
const RATE_PERCENT = /^-?\d+([.,]\d{1,2})?$/;
const MAX_ROWS = 200;
const MAX_EUR = 1e12;

/** The owner's expected yearly growth for one instrument, a percentage as a decimal string within ±50. */
export const ForecastRateInput = z
  .object({
    instrumentId: z.number().int().positive(),
    ratePercent: z
      .string()
      .refine((text) => RATE_PERCENT.test(text), "Rate in the format 6.5")
      .refine(
        (text) =>
          !RATE_PERCENT.test(text) || Math.abs(Number(text.replace(",", "."))) <= MAX_RATE_PERCENT,
        `The rate must be between −${MAX_RATE_PERCENT} % and ${MAX_RATE_PERCENT} %`,
      ),
  })
  .strict();

export const ForecastRateRemoveInput = z
  .object({ instrumentId: z.number().int().positive() })
  .strict();

const Month = z.number().int().min(0).max(MAX_FORECAST_MONTHS);
const Eur = z.number().min(-MAX_EUR).max(MAX_EUR);
const Rate = z.number().min(-0.99).max(1);
const Volatility = z.number().min(0).max(2);
const Inflation = z.number().min(-0.1).max(0.5);

/** What `forecastFor` takes: the rest comes from the caller's holdings, rates and plan. */
export const ForecastOptionsInput = z
  .object({
    months: z.number().int().min(1).max(MAX_FORECAST_MONTHS).default(120),
    real: z.boolean().default(true),
    inflation: Inflation.default(0.02),
    /** Only these instruments; all held and planned ones when absent. */
    instrumentIds: z.array(z.number().int().positive()).max(MAX_ROWS).optional(),
    on: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "The date must be in the format YYYY-MM-DD")
      .optional(),
  })
  .strict();

/** A whole scenario as plain data, for the engine. Holding ids must be unique and every reference must name one. */
export const ForecastScenarioInput = z
  .object({
    startDate: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "The start month must be YYYY-MM"),
    months: z.number().int().min(1).max(MAX_FORECAST_MONTHS),
    holdings: z
      .array(
        z
          .object({
            id: z.string().min(1).max(120),
            name: z.string().min(1).max(200),
            valueEur: Eur.min(0),
            rate: Rate,
            volatility: Volatility,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ROWS),
    contributions: z
      .array(
        z
          .object({
            holdingId: z.string().min(1).max(120),
            monthlyEur: Eur.min(0),
            fromMonth: Month.min(1).optional(),
            toMonth: Month.min(1).optional(),
            yearlyIncrease: z.number().min(-0.5).max(1).optional(),
          })
          .strict(),
      )
      .max(MAX_ROWS)
      .default([]),
    events: z
      .array(
        z
          .object({
            month: Month.min(1),
            holdingId: z.string().min(1).max(120).nullable(),
            amountEur: Eur,
          })
          .strict(),
      )
      .max(MAX_ROWS)
      .default([]),
    shocks: z
      .array(
        z
          .object({
            month: Month.min(1),
            holdingId: z.string().min(1).max(120).nullable(),
            change: z.number().min(-1).max(10),
          })
          .strict(),
      )
      .max(MAX_ROWS)
      .default([]),
    inflation: Inflation.default(0.02),
    real: z.boolean().default(true),
  })
  .strict()
  .superRefine((scenario, context) => {
    const ids = new Set(scenario.holdings.map((holding) => holding.id));
    if (ids.size !== scenario.holdings.length) {
      context.addIssue({
        code: "custom",
        message: "A holding id appears twice",
        path: ["holdings"],
      });
    }
    const references = [
      ...scenario.contributions.map((row) => row.holdingId),
      ...scenario.events.map((row) => row.holdingId),
      ...scenario.shocks.map((row) => row.holdingId),
    ];
    if (references.some((id) => id !== null && !ids.has(id))) {
      context.addIssue({
        code: "custom",
        message: "A row names a holding that is not in the scenario",
      });
    }
  });
