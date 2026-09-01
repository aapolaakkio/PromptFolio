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

/** How many rules one turn may write. A batch larger than this is a runaway. */
const MAX_RULES_PER_CALL = 20;

const CATEGORY_KEYS = Object.keys(CATEGORY_LABELS);
// SAFETY: `z.enum` needs a non-empty tuple, and `CATEGORY_LABELS` is a literal
// object with an entry for every category -- it cannot be empty without the app
// having no spending categories at all.
const CategoryEnum = z.enum(CATEGORY_KEYS as [string, ...string[]]);

const PatternSchema = z
  .string()
  .trim()
  .min(3, "Hakusanan on oltava vähintään kolme merkkiä")
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
 * The tools that let the assistant classify, rather than only describe.
 *
 * These are the only tools in the app that write, and what they write is the
 * classification, never the ledger: no amount, date or transaction can be
 * created, changed or deleted through the assistant. A rule is a lens over the
 * rows, so a wrong one misreads a total and nothing more -- and it is visible
 * on Kulutus with its source, editable and deletable there.
 *
 * A payee's text comes from an imported bank statement, which is data the app
 * did not write. Two guards keep that from becoming an instruction: a new rule
 * must name a category the app already has, and its pattern must occur in a
 * payee this user's own ledger actually contains and no rule yet matches. The
 * worst a crafted statement line can achieve is a rule pointing at a real
 * merchant of the owner's, in the wrong category, which the owner can see and
 * undo.
 */
export const buildRuleTools = (db: Db, userId: string): ChatTool[] => [
  {
    name: "save_spending_rules",
    description:
      "Tallentaa luokittelusääntöjä, jotta tuntemattomat maksunsaajat menevät jatkossa oikeaan " +
      "luokkaan. pattern on maksunsaajan nimen osa (isoin kirjaimin), category yksi sovelluksen " +
      "luokista. Käytä get_uncategorised_spending tai get_transaction_class ensin ja tallenna " +
      "vain nimiä jotka näkyivät niiden tuloksissa. Kerro käyttäjälle mitä tallensit.",
    schema: SaveRules,
    run: async (input): Promise<ToolResult> => {
      const { rules } = SaveRules.parse(input);
      const { txns, bankAccountIds } = await loadPortfolio(db, userId);
      const bank = new Set(bankAccountIds);
      // The same guard the import-time classifier applies: a pattern must occur
      // in a payee this ledger holds and nothing yet classifies. A model that
      // invents a merchant, or repeats one out of a statement's own text,
      // writes no rule.
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
      // What each new rule now catches, so an answer can say what changed
      // rather than only that something did.
      const after = await rulesFor(db, userId);
      const matched = (pattern: string): number =>
        txns.filter(
          (txn) =>
            bank.has(txn.accountId) &&
            (txn.note ?? "").toUpperCase().includes(pattern) &&
            categoriseWith(txn.note ?? "", after) !== "muu",
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
          "Säännöt tallennettiin lähteellä 'ai' ja käyttäjä voi muokata tai poistaa ne " +
          "Kulutus-sivulla. " +
          (unmatched.length > 0
            ? "Ohitetut nimet eivät esiinny yhdessäkään luokittelemattomassa tapahtumassa, " +
              "joten niille ei tallennettu sääntöä."
            : ""),
      };
    },
  },

  {
    name: "update_spending_rule",
    description:
      "Muuttaa olemassa olevan säännön luokkaa, kun luokittelu meni väärin. Ei koske sääntöihin " +
      "jotka käyttäjä on itse tehnyt -- ne kuuluvat hänelle, ja niistä on kerrottava että ne " +
      "pitää muuttaa Kulutus-sivulla.",
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
              ? "Tämän säännön on tehnyt käyttäjä itse, joten et voi muuttaa sitä. Kerro että " +
                "sen voi muuttaa Kulutus-sivulla."
              : "Tällaista sääntöä ei ole. Tarkista kirjoitusasu tai tallenna uusi sääntö.",
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
      "Poistaa säännön, joka osuu liian laajasti tai on väärin. Ei koske käyttäjän itse tekemiin " +
      "sääntöihin. Poiston jälkeen osumat palaavat luokkaan Muu.",
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
              ? "Tämän säännön on tehnyt käyttäjä itse, joten et voi poistaa sitä."
              : "Tällaista sääntöä ei ole.",
        };
      }
      return {
        removed: true,
        pattern: result.pattern,
        wasCategory: labelForCategory(result.was),
        note: "Osumat palaavat luokkaan Muu, kunnes uusi sääntö tallennetaan.",
      };
    },
  },
];
