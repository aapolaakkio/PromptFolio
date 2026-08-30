import { and, eq } from "drizzle-orm";

import type { getDb } from "../db";
import { spendingRules } from "../db/schema";
import { CATEGORY_LABELS, SEED_RULES, type Category } from "./categories";

type Db = ReturnType<typeof getDb>["db"];

export type SpendingRule = {
  readonly pattern: string;
  readonly category: Category;
  readonly source: "seed" | "ai" | "user";
};

/**
 * Whether a string names a category this app knows.
 *
 * Asked of everything the assistant proposes and everything a request carries,
 * so it reads the label table itself rather than a second list that could drift
 * from it.
 */
export const isCategory = (value: string): value is Category =>
  Object.hasOwn(CATEGORY_LABELS, value);

/**
 * The rules this user's spending is read through.
 *
 * Seeded from the built-in Finnish merchants the first time an account needs
 * them, and owned by the user afterwards: a rule they delete stays deleted, and
 * one they or the assistant adds sits beside the originals. Re-seeding on every
 * call would undo both.
 */
export const rulesFor = (db: Db, userId: string): SpendingRule[] => {
  const stored = db
    .select({
      pattern: spendingRules.pattern,
      category: spendingRules.category,
      source: spendingRules.source,
    })
    .from(spendingRules)
    .where(eq(spendingRules.userId, userId))
    .all();

  if (stored.length === 0) {
    db.insert(spendingRules)
      .values(
        SEED_RULES.map((rule) => ({
          userId,
          pattern: rule.pattern,
          category: rule.category,
          source: "seed" as const,
        })),
      )
      .run();
    return SEED_RULES.map((rule) => ({ ...rule, source: "seed" as const }));
  }

  return stored.flatMap((row) =>
    isCategory(row.category) ? [{ ...row, category: row.category }] : [],
  );
};

/**
 * Which rule a payment falls under, or null when none does.
 *
 * The longest matching pattern wins rather than the first one stored. With rules
 * arriving from three sources in no particular order, "first match" would make
 * the answer depend on insertion order -- and a specific rule ("RAVINTOLA
 * PRISMA") must beat a general one ("PRISMA") whichever was added first.
 */
export const matchRule = (note: string, rules: readonly SpendingRule[]): SpendingRule | null => {
  const text = note.toUpperCase();
  let best: SpendingRule | null = null;
  for (const rule of rules) {
    if (!text.includes(rule.pattern)) continue;
    if (best === null || rule.pattern.length > best.pattern.length) best = rule;
  }
  return best;
};

export const categoriseWith = (note: string, rules: readonly SpendingRule[]): Category =>
  matchRule(note, rules)?.category ?? "muu";

/**
 * Stores rules, skipping any that name an unknown category or a pattern the
 * user already has.
 *
 * Both skips matter for the assistant's proposals: a model asked to classify
 * merchants will occasionally invent a category name, and it must not be able
 * to overwrite a rule a person wrote by proposing the same pattern.
 */
export type RuleAdditions = { readonly added: SpendingRule[]; readonly rejected: string[] };

export const addRules = (
  db: Db,
  userId: string,
  proposed: readonly { pattern: string; category: string }[],
  source: "ai" | "user",
): RuleAdditions => {
  const existing = new Set(rulesFor(db, userId).map((rule) => rule.pattern));
  const added: SpendingRule[] = [];
  const rejected: string[] = [];

  for (const candidate of proposed) {
    const pattern = candidate.pattern.trim().toUpperCase();
    if (pattern.length < 3 || !isCategory(candidate.category)) {
      rejected.push(candidate.pattern);
      continue;
    }
    if (existing.has(pattern)) continue;

    db.insert(spendingRules)
      .values({ userId, pattern, category: candidate.category, source })
      .run();
    existing.add(pattern);
    added.push({ pattern, category: candidate.category, source });
  }

  return { added, rejected };
};

/** Deletes one rule of this user's. Returns whether there was one to delete. */
export const removeRule = (db: Db, userId: string, pattern: string): boolean => {
  const target = pattern.trim().toUpperCase();
  const deleted = db
    .delete(spendingRules)
    .where(and(eq(spendingRules.userId, userId), eq(spendingRules.pattern, target)))
    .returning({ pattern: spendingRules.pattern })
    .all();
  return deleted.length > 0;
};

/**
 * What a bank or card calls money coming back from a shop.
 *
 * A refund is not income: nobody earned it, and counting it as income both
 * inflates what came in and leaves the original purchase standing at full
 * price. It belongs against the category it came from, which is what
 * `categoriseWith` gives it -- the payee is on the row exactly as it was on the
 * purchase.
 */
const REFUND_LABELS = ["HYVITYS", "PALAUTUS"];

export const isRefund = (note: string): boolean => {
  const upper = note.toUpperCase();
  return REFUND_LABELS.some((label) => upper.includes(label));
};
