import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { EUR, parseMoney } from "../../core/money.ts";
import { BASIS_POINTS } from "../../core/rebalance/targets.ts";
import { getDb } from "../../server/db/index.ts";
import {
  depositPlanFor,
  driftReportFor,
  feeReportFor,
  rebalancePlanFor,
  saveTargets,
  targetsFor,
} from "../../server/rebalance.ts";
import { authed, readable } from "./guard.ts";

const { db } = getDb();

const Dimension = z.enum(["kind", "currency", "account", "instrument"]);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Päivämäärän on oltava muotoa YYYY-MM-DD");

/** What every question on this screen is asked about: a slicing and a date. */
const Slice = z.object({ by: Dimension.optional(), on: IsoDate.optional() });

const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * A percentage on the wire as a decimal string, like every other quantity here,
 * converted to integer basis points at the boundary. More than two decimals is
 * refused rather than rounded -- see the route this replaced for why.
 */
const toBasisPoints = (percent: string): number =>
  Math.round(Number(percent.replace(",", ".")) * (BASIS_POINTS / 100));

export const getTargets = createServerFn()
  .middleware([authed])
  .validator(Slice)
  .handler(({ data, context }) => targetsFor(db, context.userId, data.by ?? "kind"));

/** Stores a target set, which must sum to exactly 100 % or be refused whole. */
export const saveTargetAllocation = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(
    z.object({
      dimension: Dimension,
      targets: z
        .array(
          z
            .object({
              key: z.string().min(1).max(120),
              weightPercent: z.string().regex(/^\d+([.,]\d{1,2})?$/, "Osuus muodossa 12.34"),
            })
            .strict(),
        )
        .min(1)
        .max(200),
    }),
  )
  .handler(({ data, context }) => {
    const result = saveTargets(
      db,
      context.userId,
      data.dimension,
      data.targets.map((target) => ({
        key: target.key,
        weightBp: toBasisPoints(target.weightPercent),
      })),
    );
    // Refused with the total it actually sums to, so the owner can see what is
    // missing rather than being told only that it is wrong.
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
      amount: z.string().regex(/^\d+([.,]\d{1,2})?$/, "Summa muodossa 1234.56"),
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
