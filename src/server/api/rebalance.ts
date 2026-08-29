import { z } from "zod";

import type { Dimension } from "../../core/allocation";
import { EUR, parseMoney } from "../../core/money";
import { BASIS_POINTS } from "../../core/rebalance/targets";
import { requireUser } from "../auth-guard";
import { getDb } from "../db";
import { handle, HttpError, json } from "../http";
import {
  depositPlanFor,
  driftReportFor,
  feeReportFor,
  rebalancePlanFor,
  saveTargets,
  targetsFor,
} from "../rebalance";

const { db } = getDb();

const DimensionSchema = z.enum(["kind", "currency", "account", "instrument"]);
const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Päivämäärän on oltava muotoa YYYY-MM-DD");

/**
 * A target's weight as a percentage, on the wire as a decimal string like every
 * other quantity, and converted to integer basis points here at the boundary.
 * A percentage with more than two decimals is refused rather than rounded: the
 * owner typed something the model cannot hold, and silently altering it would
 * make the set they see differ from the set that was stored.
 */
const TargetSchema = z
  .object({
    key: z.string().min(1).max(120),
    weightPercent: z.string().regex(/^\d+([.,]\d{1,2})?$/, "Osuus muodossa 12.34"),
  })
  .strict();

const SaveTargetsSchema = z
  .object({
    dimension: DimensionSchema,
    targets: z.array(TargetSchema).min(1).max(200),
  })
  .strict();

const toBasisPoints = (percent: string): number =>
  Math.round(Number(percent.replace(",", ".")) * (BASIS_POINTS / 100));

const dimensionFrom = (request: Request): Dimension => {
  const raw = new URL(request.url).searchParams.get("by") ?? "kind";
  const parsed = DimensionSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "Tuntematon jaotteluperuste");
  return parsed.data;
};

const onFrom = (request: Request): string => {
  const raw = new URL(request.url).searchParams.get("on") ?? new Date().toISOString().slice(0, 10);
  const parsed = IsoDateSchema.safeParse(raw);
  if (!parsed.success)
    throw new HttpError(400, parsed.error.issues[0]?.message ?? "Virheellinen päivä");
  return parsed.data;
};

export const rebalanceRoutes = {
  "/api/targets": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      return json(targetsFor(db, userId, dimensionFrom(request)));
    }),
    PUT: handle(async (request) => {
      const { userId } = await requireUser(request);
      const parsed = SaveTargetsSchema.safeParse(await request.json());
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues[0]?.message ?? "Virheellinen tavoitejakauma");
      }
      const result = saveTargets(
        db,
        userId,
        parsed.data.dimension,
        parsed.data.targets.map((target) => ({
          key: target.key,
          weightBp: toBasisPoints(target.weightPercent),
        })),
      );
      // The set is refused with the total it actually sums to, so the owner can
      // see what is missing rather than being told only that it is wrong.
      if (!result.ok) throw new HttpError(400, result.message);
      return json({ saved: parsed.data.targets.length });
    }),
  },
  "/api/drift": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      return json(driftReportFor(db, userId, dimensionFrom(request), onFrom(request)));
    }),
  },
  "/api/deposit-plan": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      const raw = new URL(request.url).searchParams.get("amount") ?? "";
      if (!/^\d+([.,]\d{1,2})?$/.test(raw)) throw new HttpError(400, "Summa muodossa 1234.56");
      return json(
        depositPlanFor(db, userId, dimensionFrom(request), onFrom(request), parseMoney(raw, EUR)),
      );
    }),
  },
  "/api/rebalance": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      return json(rebalancePlanFor(db, userId, dimensionFrom(request), onFrom(request)));
    }),
  },
  "/api/fees": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      return json(feeReportFor(db, userId));
    }),
  },
};
