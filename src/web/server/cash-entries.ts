import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  addCashEntry,
  CashEntry,
  listCashEntries,
  removeCashEntry,
} from "../../server/cash-entries.ts";
import { authed, readable } from "./guard.ts";

const AccountId = z.number().int().positive();

/** The manual rows on one account -- what a person typed, never an import's. */
export const getCashEntries = createServerFn()
  .middleware([authed])
  .validator(z.object({ accountId: AccountId }))
  .handler(({ data, context }) => readable(() => listCashEntries(context.userId, data.accountId)));

/** Records a deposit, withdrawal, interest payment or opening balance. */
export const saveCashEntry = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(CashEntry)
  .handler(({ data, context }) => readable(() => addCashEntry(context.userId, data)));

/** Deletes one, refusing anything an import wrote. */
export const deleteCashEntry = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(z.object({ id: AccountId }))
  .handler(({ data, context }) => readable(() => removeCashEntry(context.userId, data.id)));
