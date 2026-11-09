import { createServerFn } from "@tanstack/react-start";
import {
  SpendingRuleChange,
  SpendingRuleRemove,
  SpendingRulesSave,
} from "../../server/action-inputs.ts";

import { CATEGORY_LABELS } from "../../server/spending/categories.ts";
import {
  addRules,
  isCategory,
  removeRule,
  rulesFor,
  setRuleCategory,
} from "../../server/spending/rules.ts";
import { db } from "../../server/db/index.ts";
import { authed } from "./guard.ts";

/** The rules a person's spending is read through, with the categories to pick from. */
export const getSpendingRules = createServerFn()
  .middleware([authed])
  .handler(async ({ context }) => ({
    rules: await rulesFor(db, context.userId),
    categories: Object.entries(CATEGORY_LABELS).map(([id, label]) => ({ id, label })),
  }));

/** Stores user-written rules, marked `user` so the assistant never overwrites them (see spending/rules.ts ASSISTANT_MAY_CHANGE). */
export const saveSpendingRules = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(SpendingRulesSave)
  .handler(({ data, context }) => addRules(db, context.userId, data.rules, "user"));

/** Deletes one by its pattern, reporting whether there was one to delete. */
export const deleteSpendingRule = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(SpendingRuleRemove)
  .handler(async ({ data, context }) => {
    if (!(await removeRule(db, context.userId, data.pattern))) {
      throw new Error("Rule not found");
    }
    return { ok: true };
  });

/** Moves one rule to another category; the owner's decision, so it becomes theirs. */
export const changeSpendingRule = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(SpendingRuleChange)
  .handler(async ({ data, context }) => {
    if (!isCategory(data.category)) throw new Error("Unknown category");
    if (!(await setRuleCategory(db, context.userId, data.pattern, data.category))) {
      throw new Error("Rule not found");
    }
    return { ok: true };
  });
