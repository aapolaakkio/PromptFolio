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
  takenPatterns,
} from "../../server/spending/rules.ts";
import { db } from "../../server/db/index.ts";
import { HttpError } from "../../server/errors.ts";
import { authed, readable } from "./guard.ts";

/** The rules a person's spending is read through, with the categories to pick from. */
export const getSpendingRules = createServerFn()
  .middleware([authed])
  .handler(async ({ context }) => ({
    rules: await rulesFor(db, context.userId),
    categories: Object.entries(CATEGORY_LABELS).map(([id, label]) => ({ id, label })),
  }));

const CHANGED = "The rule changed since the card was made. Ask again.";

/** Stores user-written rules, marked `user` so the import classifier never overwrites them. A chat card asks for all or none: a pattern that already has a rule refuses the whole save. */
export const saveSpendingRules = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(SpendingRulesSave)
  .handler(({ data, context }) =>
    readable(async () => {
      if (data.refuseExisting === true) {
        const taken = await takenPatterns(db, context.userId, data.rules);
        if (taken.length > 0) {
          throw new HttpError(409, `Nothing saved: ${taken.join(", ")} already has a rule`);
        }
      }
      return addRules(db, context.userId, data.rules, "user");
    }),
  );

/** Deletes one by its pattern, reporting whether there was one to delete. */
export const deleteSpendingRule = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(SpendingRuleRemove)
  .handler(({ data, context }) =>
    readable(async () => {
      const removed = await removeRule(db, context.userId, data.pattern, data);
      if (removed === "changed") throw new HttpError(409, CHANGED);
      if (!removed) throw new HttpError(404, "Rule not found");
      return { ok: true };
    }),
  );

/** Moves one rule to another category; the owner's decision, so it becomes theirs. */
export const changeSpendingRule = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(SpendingRuleChange)
  .handler(({ data, context }) =>
    readable(async () => {
      if (!isCategory(data.category)) throw new HttpError(400, "Unknown category");
      const result = await setRuleCategory(
        db,
        context.userId,
        data.pattern,
        data.category,
        data.expectCategory,
      );
      if (result === "changed") throw new HttpError(409, CHANGED);
      if (result === "missing") throw new HttpError(404, "Rule not found");
      return { ok: true };
    }),
  );
