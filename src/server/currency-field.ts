import { z } from "zod";
import { parseCurrency } from "../core/money.ts";

/**
 * The zod field for a request body's currency. Delegates the actual ISO
 * 4217 validation to `core/money.ts`'s `parseCurrency` (the single source
 * of truth for "is this a currency code") rather than duplicating its
 * regex here, and turns a `parseCurrency` throw into a zod issue so it
 * surfaces through `http.ts`'s existing `ZodError` -> 400-with-field-detail
 * handling instead of an unhandled throw. Shared by every route (currently
 * `instruments.ts`, `accounts.ts`) that accepts a currency in its body.
 */
export const currencyField = z.string().transform((value, ctx) => {
  try {
    return parseCurrency(value);
  } catch (cause) {
    ctx.addIssue({
      code: "custom",
      message: cause instanceof Error ? cause.message : "Virheellinen valuuttakoodi",
    });
    return z.NEVER;
  }
});
