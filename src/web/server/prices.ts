import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { isRealCalendarDate } from "../../server/calendar-date.ts";
import { getDb } from "../../server/db/index.ts";
import { recordManualPrice } from "../../server/prices/manual.ts";
import { authed, readable } from "./guard.ts";

const { db } = getDb();

/**
 * What a person may type into the price form.
 *
 * Exported so the tests can reach it: the cases that used to send a bad date
 * over HTTP and assert a 400 now assert against the schema, which is where the
 * refusal lives. The calendar check sits on top of the shape because
 * 2024-02-31 matches the pattern and is not a day.
 */
export const PriceInput = z.object({
  instrumentId: z.number().int().positive(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Päivämäärän on oltava muodossa VVVV-KK-PP")
    .refine(isRealCalendarDate, "Päivämäärä ei ole olemassa oleva kalenteripäivä"),
  // A decimal string, never a JSON number: money crossing this boundary is
  // always text, and a human-typed price doubly so -- untrusted input that goes
  // through core/money's own parser, never Number().
  price: z.string().min(1, "Hinta puuttuu").max(30, "Hinta on liian pitkä"),
});

/**
 * Records a price by hand, for a holding no source can price -- a delisted
 * share, an unlisted fund, a corporate action's leftover line.
 */
export const savePrice = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(
    z.object({
      instrumentId: z.number().int().positive(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Päivämäärän on oltava muodossa VVVV-KK-PP"),
      price: z.string().min(1),
    }),
  )
  .handler(({ data }) => readable(() => recordManualPrice(db, data)));
