import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { DebtBalanceInput, DebtBalanceRemoveInput, DebtInput } from "../../server/action-inputs.ts";
import {
  addDebt,
  listDebts,
  removeDebt,
  removeDebtBalance,
  setDebtBalance,
} from "../../server/debts.ts";
import { db } from "../../server/db/index.ts";
import { authed, readable } from "./guard.ts";

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "The date must be in the format YYYY-MM-DD");

const today = (): string => new Date().toISOString().slice(0, 10);

export const getDebts = createServerFn()
  .middleware([authed])
  .validator(z.object({ on: IsoDate.optional() }))
  .handler(({ data, context }) => listDebts(db, context.userId, data.on ?? today()));

export const createDebt = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(DebtInput)
  .handler(({ data, context }) => addDebt(db, context.userId, data));

export const deleteDebt = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(z.object({ debtId: z.number().int().positive() }))
  .handler(({ data, context }) => readable(() => removeDebt(db, context.userId, data.debtId)));

export const saveDebtBalance = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(DebtBalanceInput)
  .handler(({ data, context }) => readable(() => setDebtBalance(db, context.userId, data)));

export const deleteDebtBalance = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(DebtBalanceRemoveInput)
  .handler(({ data, context }) => readable(() => removeDebtBalance(db, context.userId, data)));
