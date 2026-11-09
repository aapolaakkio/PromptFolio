import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { isRealCalendarDate } from "../../server/calendar-date.ts";
import { db } from "../../server/db/index.ts";
import { recordManualPrice } from "../../server/prices/manual.ts";
import { runScheduledRefresh } from "../../server/prices/refresh.ts";
import { authed, readable } from "./guard.ts";

/** The price-form schema; the calendar check sits on the shape since 2024-02-31 matches the pattern. */
export const PriceInput = z.object({
  instrumentId: z.number().int().positive(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "The date must be in the format YYYY-MM-DD")
    .refine(isRealCalendarDate, "The date is not a real calendar date"),
  // A decimal string, never a JSON number; parsed by core/money, never Number().
  price: z.string().min(1, "Price is missing").max(30, "Price is too long"),
});

/** Records a price by hand for a holding no source can price (delisted share, unlisted fund). */
export const savePrice = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(
    z.object({
      instrumentId: z.number().int().positive(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "The date must be in the format YYYY-MM-DD"),
      price: z.string().min(1),
    }),
  )
  .handler(({ data }) => readable(() => recordManualPrice(db, data)));

/** The weekday cron's refresh on demand; prices are household-shared, so any signed-in member may run it. */
// ponytail: no throttle; the button disables while a run is in flight. Add one
// if the price sources start refusing repeated runs.
export const refreshPricesNow = createServerFn({ method: "POST" })
  .middleware([authed])
  .handler(() => readable(() => runScheduledRefresh(db)));
