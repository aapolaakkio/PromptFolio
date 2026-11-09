import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";

import { EUR, addMoney, formatMoney, money, parseMoney, zeroMoney } from "../core/money.ts";
import type { PlanRowInput, PlanSave } from "./action-inputs.ts";
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

/** Rows and amounts in one string; a card is built against it and Confirm refuses once it differs. */
export const planFingerprint = async (db: Db, userId: string): Promise<string> =>
  (
    await db
      .select({ id: monthlyPlan.instrumentId, amount: monthlyPlan.amountMinor })
      .from(monthlyPlan)
      .where(eq(monthlyPlan.userId, userId))
      .all()
  )
    .map((row) => `${row.id}:${row.amount}`)
    .sort()
    .join(",");

const upsertFor = (db: Db, userId: string, row: z.infer<typeof PlanRowInput>) => {
  const amountMinor = Number(parseMoney(row.amountEur, EUR).minor);
  return db
    .insert(monthlyPlan)
    .values({ userId, instrumentId: row.instrumentId, amountMinor })
    .onConflictDoUpdate({
      target: [monthlyPlan.userId, monthlyPlan.instrumentId],
      set: { amountMinor },
    });
};

const assertKnown = async (db: Db, ids: readonly number[]): Promise<void> => {
  const known = await db
    .select({ id: instruments.id })
    .from(instruments)
    .where(inArray(instruments.id, [...ids]))
    .all();
  if (known.length !== new Set(ids).size) throw new HttpError(404, "Instrument not found");
};

/** All rows or none: ids and the plan's fingerprint are checked before the one batch (a single D1 transaction) writes. Deletes only the ids the card listed. The registry is household-shared, so an instrument need only exist, not be held. */
export const setPlanRows = async (
  db: Db,
  userId: string,
  input: z.infer<typeof PlanSave>,
): Promise<void> => {
  await assertKnown(
    db,
    input.rows.map((row) => row.instrumentId),
  );
  if ((await planFingerprint(db, userId)) !== input.fingerprint) {
    throw new HttpError(409, "The plan changed since this was proposed; ask again");
  }
  const removal = db
    .delete(monthlyPlan)
    .where(
      and(
        eq(monthlyPlan.userId, userId),
        inArray(monthlyPlan.instrumentId, [...input.removeInstrumentIds]),
      ),
    );
  const upserts = input.rows.map((row) => upsertFor(db, userId, row));
  const statements = input.removeInstrumentIds.length > 0 ? [removal, ...upserts] : upserts;
  // SAFETY: PlanSave requires at least one row, so `statements` is never empty.
  await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
};

/** One row, as the page's form sends it. */
export const setPlanRow = async (
  db: Db,
  userId: string,
  row: z.infer<typeof PlanRowInput>,
): Promise<void> => {
  await assertKnown(db, [row.instrumentId]);
  await upsertFor(db, userId, row).run();
};

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
