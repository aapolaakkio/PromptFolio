import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import { owedOn, type DebtBalance } from "../core/debts.ts";
import { EUR, formatMoney, money, parseMoney } from "../core/money.ts";
import type { IsoDate } from "../core/types.ts";
import type { DebtBalanceInput, DebtBalanceRemoveInput, DebtInput } from "./action-inputs.ts";
import { toBasisPoints } from "./action-inputs.ts";
import type { Db } from "./db/index.ts";
import { debtBalances, debts } from "./db/schema.ts";
import { HttpError } from "./errors.ts";
import { helsinkiToday } from "./summary/helsinki.ts";

export type DebtView = {
  readonly id: number;
  readonly name: string;
  readonly kind: "student_loan" | "credit_card";
  readonly interestRatePct: string | null;
  readonly owedEur: string;
  readonly asOf: string | null;
  readonly balances: readonly {
    readonly asOf: string;
    readonly owedEur: string;
    readonly source: "import" | "manual";
  }[];
};

const BP_PER_PERCENT = 100;

const formatRate = (bp: number | null): string | null =>
  bp === null ? null : (bp / BP_PER_PERCENT).toFixed(2);

const owned = async (db: Db, userId: string, debtId: number): Promise<void> => {
  const found = await db
    .select({ id: debts.id })
    .from(debts)
    .where(and(eq(debts.id, debtId), eq(debts.userId, userId)))
    .get();
  if (!found) throw new HttpError(404, "Debt not found");
};

const balanceRows = (db: Db, userId: string) =>
  db
    .select({
      debtId: debtBalances.debtId,
      asOf: debtBalances.asOf,
      owedMinor: debtBalances.owedMinor,
      source: debtBalances.source,
    })
    .from(debtBalances)
    .innerJoin(debts, eq(debts.id, debtBalances.debtId))
    .where(eq(debts.userId, userId))
    .all();

const toBalance = (row: { debtId: number; asOf: string; owedMinor: number }): DebtBalance => ({
  debtId: row.debtId,
  asOf: row.asOf,
  owed: money(BigInt(row.owedMinor), EUR),
});

export const debtBalancesFor = async (db: Db, userId: string): Promise<DebtBalance[]> =>
  (await balanceRows(db, userId)).map(toBalance);

export const listDebts = async (
  db: Db,
  userId: string,
  on: IsoDate,
): Promise<{ readonly debts: readonly DebtView[]; readonly totalOwedEur: string }> => {
  const [rows, stored] = await Promise.all([
    db.select().from(debts).where(eq(debts.userId, userId)).orderBy(debts.name, debts.id).all(),
    balanceRows(db, userId),
  ]);
  const view = (row: (typeof rows)[number]): DebtView => {
    const own = stored
      .filter((balance) => balance.debtId === row.id)
      .toSorted((a, b) => (a.asOf < b.asOf ? 1 : a.asOf > b.asOf ? -1 : 0));
    const owedBalances = own.map(toBalance);
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      interestRatePct: formatRate(row.interestRateBp),
      owedEur: formatMoney(owedOn(owedBalances, on)),
      asOf: own.find((balance) => balance.asOf <= on)?.asOf ?? null,
      balances: own.map((balance) => ({
        asOf: balance.asOf,
        owedEur: formatMoney(toBalance(balance).owed),
        source: balance.source,
      })),
    };
  };
  return { debts: rows.map(view), totalOwedEur: formatMoney(owedOn(stored.map(toBalance), on)) };
};

export const addDebt = async (
  db: Db,
  userId: string,
  input: z.infer<typeof DebtInput>,
): Promise<{ id: number }> => {
  const interestRateBp =
    input.interestRatePct === undefined ? null : toBasisPoints(input.interestRatePct);
  const inserted = await db
    .insert(debts)
    .values({ userId, name: input.name, kind: input.kind, interestRateBp })
    .returning({ id: debts.id })
    .get();
  return { id: inserted.id };
};

export const removeDebt = async (db: Db, userId: string, debtId: number): Promise<void> => {
  await owned(db, userId, debtId);
  await db
    .delete(debts)
    .where(and(eq(debts.id, debtId), eq(debts.userId, userId)))
    .run();
};

export const setDebtBalance = async (
  db: Db,
  userId: string,
  input: z.infer<typeof DebtBalanceInput>,
): Promise<void> => {
  await owned(db, userId, input.debtId);
  if (input.asOf > helsinkiToday(new Date())) {
    throw new HttpError(400, "A balance cannot be dated in the future");
  }
  const owedMinor = Number(parseMoney(input.owedEur, EUR).minor);
  await db
    .insert(debtBalances)
    .values({ debtId: input.debtId, asOf: input.asOf, owedMinor, source: "manual" })
    .onConflictDoUpdate({
      target: [debtBalances.debtId, debtBalances.asOf],
      set: { owedMinor, source: "manual", importId: null },
    })
    .run();
};

export const removeDebtBalance = async (
  db: Db,
  userId: string,
  input: z.infer<typeof DebtBalanceRemoveInput>,
): Promise<void> => {
  await owned(db, userId, input.debtId);
  await db
    .delete(debtBalances)
    .where(and(eq(debtBalances.debtId, input.debtId), eq(debtBalances.asOf, input.asOf)))
    .run();
};
