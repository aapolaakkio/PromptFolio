import { z } from "zod";
import { parseCurrency } from "../core/money.ts";

/** The zod field for a currency in a request body: delegates to `parseCurrency` (the single source of truth) and turns its throw into a zod issue, so `http.ts` answers 400 with field detail. */
export const currencyField = z.string().transform((value, ctx) => {
  try {
    return parseCurrency(value);
  } catch (cause) {
    ctx.addIssue({
      code: "custom",
      message: cause instanceof Error ? cause.message : "Invalid currency code",
    });
    return z.NEVER;
  }
});
