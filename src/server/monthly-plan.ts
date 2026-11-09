import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { z } from "zod";

import { EUR, addMoney, formatMoney, money, parseMoney, zeroMoney } from "../core/money.ts";
import type { PlanInput, PlanRowInput } from "./action-inputs.ts";
import type { Db } from "./db/index.ts";
import { instruments, monthlyPlan } from "./db/schema.ts";
import { HttpError } from "./errors.ts";

export type PlanRow = {
  readonly instrumentId: number;
  readonly name: string;
  readonly isin: string | null;
  readonly amountEur: string;
};

export const listPlan = async (
  db: Db,
  userId: string,
): Promise<{ readonly rows: readonly PlanRow[]; readonly totalEur: string }> => {
  const stored = await db
    .select({
      instrumentId: monthlyPlan.instrumentId,
      name: instruments.name,
      isin: instruments.isin,
      amountMinor: monthlyPlan.amountMinor,
    })
    .from(monthlyPlan)
    .innerJoin(instruments, eq(instruments.id, monthlyPlan.instrumentId))
    .where(eq(monthlyPlan.userId, userId))
    .orderBy(instruments.name, monthlyPlan.id)
    .all();
  const amounts = stored.map((row) => money(BigInt(row.amountMinor), EUR));
  const total = amounts.reduce(addMoney, zeroMoney(EUR));
  return {
    rows: stored.map((row, index) => ({
      instrumentId: row.instrumentId,
      name: row.name,
      isin: row.isin,
      amountEur: formatMoney(amounts[index] ?? zeroMoney(EUR)),
    })),
    totalEur: formatMoney(total),
  };
};

/** All rows or none: every id is checked before the one batch (a single D1 transaction) writes. The registry is household-shared, so an instrument need only exist, not be held. */
export const setPlanRows = async (
  db: Db,
  userId: string,
  input: z.infer<typeof PlanInput>,
): Promise<void> => {
  const ids = input.rows.map((row) => row.instrumentId);
  const known = await db
    .select({ id: instruments.id })
    .from(instruments)
    .where(inArray(instruments.id, ids))
    .all();
  if (known.length !== new Set(ids).size) throw new HttpError(404, "Instrument not found");
  const upserts = input.rows.map((row) => {
    const amountMinor = Number(parseMoney(row.amountEur, EUR).minor);
    return db
      .insert(monthlyPlan)
      .values({ userId, instrumentId: row.instrumentId, amountMinor })
      .onConflictDoUpdate({
        target: [monthlyPlan.userId, monthlyPlan.instrumentId],
        set: { amountMinor },
      });
  });
  const unlisted = db
    .delete(monthlyPlan)
    .where(and(eq(monthlyPlan.userId, userId), notInArray(monthlyPlan.instrumentId, ids)));
  const statements = input.mode === "replace" ? [unlisted, ...upserts] : upserts;
  // SAFETY: input.rows has at least one row (PlanInput), so `statements` is never empty.
  await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
};

/** One row, as the page's form sends it. */
export const setPlanRow = (db: Db, userId: string, row: z.infer<typeof PlanRowInput>) =>
  setPlanRows(db, userId, { rows: [row], mode: "add" });

export const removePlanRow = async (
  db: Db,
  userId: string,
  instrumentId: number,
): Promise<void> => {
  await db
    .delete(monthlyPlan)
    .where(and(eq(monthlyPlan.userId, userId), eq(monthlyPlan.instrumentId, instrumentId)))
    .run();
};
