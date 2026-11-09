import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  BalanceInput,
  CommitBankDraft,
  commitBankDraft,
  previewBankStatement,
  setAccountBalance,
} from "../../server/import/bank-service.ts";
import { authed, readable } from "./guard.ts";

// An upload travels as multipart; the fields inside are checked server-side.
const upload = z.instanceof(FormData);

export const previewBankImport = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(upload)
  .handler(({ data, context }) => readable(() => previewBankStatement(context.userId, data)));

export const commitBankDraftImport = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(CommitBankDraft)
  .handler(({ data, context }) => readable(() => commitBankDraft(context.userId, data)));

export const recordAccountBalance = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(BalanceInput)
  .handler(({ data, context }) => readable(() => setAccountBalance(context.userId, data)));
