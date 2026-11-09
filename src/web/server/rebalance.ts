import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { EUR, parseMoney } from "../../core/money.ts";
import {
  DimensionInput,
  PlanInput,
  PlanRemoveInput,
  PlanRowInput,
  TargetAllocationInput,
  toBasisPoints,
} from "../../server/action-inputs.ts";
import { db } from "../../server/db/index.ts";
import { listPlan, removePlanRow, setPlanRow, setPlanRows } from "../../server/monthly-plan.ts";
import {
  depositPlanFor,
  driftReportFor,
  feeReportFor,
  rebalancePlanFor,
  saveTargets,
  targetsFor,
} from "../../server/rebalance.ts";
import { authed, readable } from "./guard.ts";

const Dimension = DimensionInput;
const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "The date must be in the format YYYY-MM-DD");

/** What every question on this screen is asked about: a slicing and a date. */
const Slice = z.object({ by: Dimension.optional(), on: IsoDate.optional() });

const today = (): string => new Date().toISOString().slice(0, 10);

export const getTargets = createServerFn()
  .middleware([authed])
  .validator(Slice)
  .handler(({ data, context }) => targetsFor(db, context.userId, data.by ?? "kind"));

/** Stores a target set, which must sum to exactly 100 % or be refused whole. */
export const saveTargetAllocation = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(TargetAllocationInput)
  .handler(async ({ data, context }) => {
    const result = await saveTargets(
      db,
      context.userId,
      data.dimension,
      data.targets.map((target) => ({
        key: target.key,
        weightBp: toBasisPoints(target.weightPercent),
      })),
    );
    // Refused with the actual total so the owner sees what is missing.
    if (!result.ok) throw new Error(result.message);
    return { saved: data.targets.length };
  });

export const getDrift = createServerFn()
  .middleware([authed])
  .validator(Slice)
  .handler(({ data, context }) =>
    driftReportFor(db, context.userId, data.by ?? "kind", data.on ?? today()),
  );

/** Where money about to be paid in should go. Buys only, never a sale. */
export const getDepositPlan = createServerFn()
  .middleware([authed])
  .validator(
    Slice.extend({
      amount: z.string().regex(/^\d+([.,]\d{1,2})?$/, "Amount in the format 1234.56"),
    }),
  )
  .handler(({ data, context }) =>
    readable(() =>
      depositPlanFor(
        db,
        context.userId,
        data.by ?? "kind",
        data.on ?? today(),
        parseMoney(data.amount, EUR),
      ),
    ),
  );

/** The full plan, where every sale states the gain it would realise. */
export const getRebalancePlan = createServerFn()
  .middleware([authed])
  .validator(Slice)
  .handler(({ data, context }) =>
    rebalancePlanFor(db, context.userId, data.by ?? "kind", data.on ?? today()),
  );

/** Fees per year, with capital income tax withheld kept in its own column. */
export const getFees = createServerFn()
  .middleware([authed])
  .handler(({ context }) => feeReportFor(db, context.userId));

export const getMonthlyPlan = createServerFn()
  .middleware([authed])
  .handler(({ context }) => listPlan(db, context.userId));

/** One row per instrument: saving again replaces the sum. */
export const savePlanRow = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(PlanRowInput)
  .handler(({ data, context }) => setPlanRow(db, context.userId, data));

export const deletePlanRow = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(PlanRemoveInput)
  .handler(({ data, context }) => removePlanRow(db, context.userId, data.instrumentId));

/** The whole plan at once, from a chat card the owner confirmed; atomic. */
export const savePlan = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(PlanInput)
  .handler(({ data, context }) => setPlanRows(db, context.userId, data));
