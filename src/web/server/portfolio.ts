import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../../server/db/index.ts";
import { holdingsFor } from "../../server/valuation.ts";
import {
  allocationView,
  cashFlowView,
  cashView,
  classifiedView,
  monthlyView,
  returnsView,
  spendingView,
  uncategorisedView,
  valueSeriesView,
} from "../../server/views/portfolio.ts";
import { authed } from "./guard.ts";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Päivämäärän on oltava muodossa VVVV-KK-PP");

const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * The range every history question takes, defaulting to "since the beginning".
 *
 * A backwards range is refused rather than silently answered with nothing. The
 * routes did this and it is worth keeping: an empty chart for a typo'd date
 * looks exactly like an empty chart for an empty portfolio.
 */
export const Range = z
  .object({ from: IsoDate.optional(), to: IsoDate.optional() })
  .refine((range) => (range.from ?? "") <= (range.to ?? "9999-12-31"), {
    message: "'from' on oltava ennen tai sama kuin 'to'",
    path: ["from"],
  });

/**
 * Every holding on a date, valued.
 *
 * The same `holdingsFor` the route called; what has gone is the round trip
 * through a URL and back through a second copy of the shape on the client.
 * The page now gets the function's own return type, so a field renamed here is
 * a type error in the component rather than a zod failure at runtime.
 */
export const getHoldings = createServerFn()
  .middleware([authed])
  .validator(z.object({ on: IsoDate.optional() }))
  .handler(({ data, context }) => holdingsFor(db, context.userId, data.on ?? today()));

/** Balances per account and currency on a date, with what is locked marked. */
export const getCash = createServerFn()
  .middleware([authed])
  .validator(z.object({ on: IsoDate.optional() }))
  .handler(({ data, context }) => cashView(db, context.userId, data.on ?? today()));

/** Portfolio value and money paid in, one point per day, for the chart. */
export const getValueSeries = createServerFn()
  .middleware([authed])
  .validator(Range)
  .handler(({ data, context }) =>
    valueSeriesView(db, context.userId, data.from, data.to ?? today()),
  );

/** The allocation on a date, and every holding it could not place, with reasons. */
/** The slicings this app knows. Exported so the refusal can be tested. */
export const AllocationInput = z.object({
  on: IsoDate.optional(),
  by: z.enum(["kind", "currency", "account", "instrument"]).optional(),
});

export const getAllocation = createServerFn()
  .middleware([authed])
  .validator(AllocationInput)
  .handler(({ data, context }) =>
    allocationView(db, context.userId, data.by ?? "kind", data.on ?? today()),
  );

/** Time-weighted and money-weighted return over a window, with what was excluded. */
export const getReturns = createServerFn()
  .middleware([authed])
  .validator(Range)
  .handler(({ data, context }) =>
    returnsView(db, context.userId, data.from ?? "1900-01-01", data.to ?? today()),
  );

/** Income, spending, investing and what was left, for the Sankey. */
export const getCashFlow = createServerFn()
  .middleware([authed])
  .validator(Range)
  .handler(({ data, context }) =>
    cashFlowView(db, context.userId, data.from ?? "1900-01-01", data.to ?? today()),
  );

/** Spending grouped by category or payee, already added up. */
export const getSpending = createServerFn()
  .middleware([authed])
  .validator(
    Range.extend({
      by: z.enum(["category", "counterparty"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
  )
  .handler(({ data, context }) =>
    spendingView(
      db,
      context.userId,
      data.from ?? "1900-01-01",
      data.to ?? today(),
      data.by ?? "category",
      data.limit ?? 15,
    ),
  );

/** Income and spending per month, and the same months split by category. */
export const getMonthlySpending = createServerFn()
  .middleware([authed])
  .validator(Range)
  .handler(({ data, context }) =>
    monthlyView(db, context.userId, data.from ?? "1900-01-01", data.to ?? today()),
  );

/** Every bank movement with the class it was given, and why it was excluded. */
export const getClassifiedTransactions = createServerFn()
  .middleware([authed])
  .validator(Range)
  .handler(({ data, context }) =>
    classifiedView(db, context.userId, data.from ?? "1900-01-01", data.to ?? today()),
  );

/** The payees no rule recognised, which is the list a person works through. */
export const getUncategorised = createServerFn()
  .middleware([authed])
  .validator(Range)
  .handler(({ data, context }) =>
    uncategorisedView(db, context.userId, data.from ?? "1900-01-01", data.to ?? today()),
  );
