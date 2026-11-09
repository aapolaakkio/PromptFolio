import { createServerFn } from "@tanstack/react-start";
import { db } from "../../server/db/index.ts";

import { CreateAccount, EditAccountInput } from "../../server/action-inputs.ts";
import { listAccounts, openAccount, updateAccount } from "../../server/accounts.ts";
import { authed, readable } from "./guard.ts";

/** Every account the signed-in person owns, brokerage and bank alike. */
export const getAccounts = createServerFn()
  .middleware([authed])
  .handler(({ context }) => listAccounts(db, context.userId));

/** Opens one. The kind decides which types are allowed, and the type the terms. */
export const createAccount = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(CreateAccount)
  .handler(({ data, context }) => readable(() => openAccount(db, context.userId, data)));

/** Renames one, or changes its type, maturity date or rate. */
export const editAccount = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(EditAccountInput)
  .handler(({ data, context }) =>
    readable(() => updateAccount(db, context.userId, data.id, data.changes)),
  );
