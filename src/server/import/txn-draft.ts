import { z } from "zod";

import { parseCurrency } from "../../core/money.ts";

/**
 * A `Draft` as the browser sends it back after editing. Strict at every level:
 * a field the map never produced is a field the commit never expected.
 */
export const DraftBody = z
  .object({
    txns: z
      .array(
        z
          .object({
            line: z.number().int(),
            accountId: z.number().int().positive(),
            instrumentId: z.number().int().positive().nullable(),
            isin: z.string().nullable(),
            type: z.string().min(1),
            tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            quantity: z.number().int(),
            unitPrice: z.number().int().nullable(),
            amount: z.number().int(),
            fee: z.number().int(),
            tax: z.number().int(),
            currency: z
              .string()
              .regex(/^[A-Z]{3}$/, "Valuuttakoodin on oltava kolme isoa kirjainta")
              .transform(parseCurrency),
            fxRateEur: z.number().int().nonnegative(),
            externalId: z.string().nullable(),
            note: z.string().nullable(),
          })
          .strict(),
      )
      .max(5000),
    problems: z.array(
      z
        .object({
          line: z.number().int(),
          message: z.string(),
          raw: z.record(z.string(), z.string()),
          rawLine: z.string().optional(),
          ignored: z.boolean().optional(),
        })
        .strict(),
    ),
    unknownIsins: z.array(
      z
        .object({
          isin: z.string().nullable(),
          name: z.string(),
          currency: z
            .string()
            .regex(/^[A-Z]{3}$/, "Valuuttakoodin on oltava kolme isoa kirjainta")
            .transform(parseCurrency),
        })
        .strict(),
    ),
  })
  .strict();
export type DraftBody = z.infer<typeof DraftBody>;
