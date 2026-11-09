import { z } from "zod";

import { CATEGORY_LABELS, labelForCategory } from "../spending/categories.ts";
import { unknownMerchants } from "../spending/classify.ts";
import {
  addRules,
  categoriseWith,
  isCategory,
  recategoriseRule,
  retractRule,
  rulesFor,
} from "../spending/rules.ts";
import { loadPortfolio } from "../valuation.ts";
import { type ChatTool, type Db, type ToolResult } from "./tool-types.ts";

const MAX_RULES_PER_CALL = 20;

const CATEGORY_KEYS = Object.keys(CATEGORY_LABELS);
// SAFETY: `z.enum` needs a non-empty tuple and `CATEGORY_LABELS` has an entry per category.
const CategoryEnum = z.enum(CATEGORY_KEYS as [string, ...string[]]);

const PatternSchema = z
  .string()
  .trim()
  .min(3, "The search term must be at least three characters")
  .max(120);

const SaveRules = z
  .object({
    rules: z
      .array(z.object({ pattern: PatternSchema, category: CategoryEnum }).strict())
      .min(1)
      .max(MAX_RULES_PER_CALL),
  })
  .strict();

const ChangeRule = z.object({ pattern: PatternSchema, category: CategoryEnum }).strict();
const DropRule = z.object({ pattern: PatternSchema }).strict();

/**
 * The only tools that write, and only classification, never the ledger; a wrong rule is visible
 * and editable on the Spending page. Payee text is untrusted statement data, so a new rule must
 * name an existing category and its pattern must occur in a payee of this user's ledger that no
 * rule matches yet.
 */
export const buildRuleTools = (db: Db, userId: string): ChatTool[] => [
  {
    name: "save_spending_rules",
    description:
      "Saves categorisation rules so unknown payees go to the right category in future. " +
      "pattern is part of the payee name (in upper case), category one of the app's " +
      "categories. Use get_uncategorised_spending or get_transaction_class first and save " +
      "only names that appeared in their results. Tell the user what you saved.",
    schema: SaveRules,
    run: async (input): Promise<ToolResult> => {
      const { rules } = SaveRules.parse(input);
      const { txns, bankAccountIds } = await loadPortfolio(db, userId);
      const bank = new Set(bankAccountIds);
      // Same guard as import-time classification: an invented or statement-repeated merchant writes no rule.
      const unknown = unknownMerchants(txns, await rulesFor(db, userId), bank).map((name) =>
        name.toUpperCase(),
      );
      const grounded: { pattern: string; category: string }[] = [];
      const unmatched: string[] = [];
      for (const rule of rules) {
        const pattern = rule.pattern.toUpperCase();
        if (unknown.some((merchant) => merchant.includes(pattern))) {
          grounded.push({ pattern, category: rule.category });
        } else {
          unmatched.push(rule.pattern);
        }
      }

      const { added, rejected } = await addRules(db, userId, grounded, "ai");
      // What each new rule now catches, so an answer can say what changed.
      const after = await rulesFor(db, userId);
      const matched = (pattern: string): number =>
        txns.filter(
          (txn) =>
            bank.has(txn.accountId) &&
            (txn.note ?? "").toUpperCase().includes(pattern) &&
            categoriseWith(txn.note ?? "", after) !== "other",
        ).length;

      return {
        added: added.map((rule) => ({
          pattern: rule.pattern,
          category: rule.category,
          label: labelForCategory(rule.category),
          matches: matched(rule.pattern),
        })),
        skipped: [...rejected, ...unmatched],
        note:
          "The rules were saved with source 'ai' and the user can edit or delete them " +
          "on the Spending page. " +
          (unmatched.length > 0
            ? "The skipped names do not appear in any uncategorised transaction, " +
              "so no rule was saved for them."
            : ""),
      };
    },
  },

  {
    name: "update_spending_rule",
    description:
      "Changes the category of an existing rule when the categorisation went wrong. Does not apply to rules " +
      "the user made themselves -- they belong to the user, and the user must be told they " +
      "have to be changed on the Spending page.",
    schema: ChangeRule,
    run: async (input): Promise<ToolResult> => {
      const { pattern, category } = ChangeRule.parse(input);
      // SAFETY: `category` comes from `CategoryEnum`, built from the same label
      // table `isCategory` reads -- the check is here so the type follows.
      if (!isCategory(category)) return { changed: false, reason: "unknown-category" };
      const result = await recategoriseRule(db, userId, pattern, category);

      if (!result.ok) {
        return {
          changed: false,
          reason: result.reason,
          note:
            result.reason === "owned-by-user"
              ? "The user made this rule themselves, so you cannot change it. Say that " +
                "it can be changed on the Spending page."
              : "No such rule exists. Check the spelling or save a new rule.",
        };
      }
      return {
        changed: true,
        pattern: result.pattern,
        from: labelForCategory(result.was),
        to: labelForCategory(category),
      };
    },
  },

  {
    name: "remove_spending_rule",
    description:
      "Deletes a rule that matches too broadly or is wrong. Does not apply to rules the user made " +
      "themselves. After deletion, matches return to the category Other.",
    schema: DropRule,
    run: async (input): Promise<ToolResult> => {
      const { pattern } = DropRule.parse(input);
      const result = await retractRule(db, userId, pattern);

      if (!result.ok) {
        return {
          removed: false,
          reason: result.reason,
          note:
            result.reason === "owned-by-user"
              ? "The user made this rule themselves, so you cannot delete it."
              : "No such rule exists.",
        };
      }
      return {
        removed: true,
        pattern: result.pattern,
        wasCategory: labelForCategory(result.was),
        note: "Matches return to the category Other until a new rule is saved.",
      };
    },
  },
];
