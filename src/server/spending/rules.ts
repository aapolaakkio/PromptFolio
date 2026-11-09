import { and, eq } from "drizzle-orm";

import { chunkForInsert, type Db } from "../db/index.ts";
import { spendingRules } from "../db/schema.ts";
import { CATEGORY_LABELS, SEED_RULES, type Category } from "./categories.ts";

export type SpendingRule = {
  readonly pattern: string;
  readonly category: Category;
  readonly source: "seed" | "ai" | "user";
};

/** Reads the label table itself, so there is no second category list to drift. */
export const isCategory = (value: string): value is Category =>
  Object.hasOwn(CATEGORY_LABELS, value);

/** Seeded once, then the user's: a deleted rule stays deleted. */
export const rulesFor = async (db: Db, userId: string): Promise<SpendingRule[]> => {
  const stored = await db
    .select({
      pattern: spendingRules.pattern,
      category: spendingRules.category,
      source: spendingRules.source,
    })
    .from(spendingRules)
    .where(eq(spendingRules.userId, userId))
    .all();

  if (stored.length === 0) {
    const seeds = SEED_RULES.map((rule) => ({
      userId,
      pattern: rule.pattern,
      category: rule.category,
      source: "seed" as const,
    }));
    // Chunked (D1 caps bound variables per insert) and batched so the seed lands whole or not at all.
    const inserts = chunkForInsert(seeds, 4).map((chunk) => db.insert(spendingRules).values(chunk));
    // SAFETY: SEED_RULES is non-empty, so `chunkForInsert` returns at least one chunk.
    await db.batch(inserts as [(typeof inserts)[number], ...typeof inserts]);
    return SEED_RULES.map((rule) => ({ ...rule, source: "seed" as const }));
  }

  return stored.flatMap((row) =>
    isCategory(row.category) ? [{ ...row, category: row.category }] : [],
  );
};

/** The longest matching pattern wins, so a specific rule beats a general one whatever the order stored. */
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
  matchRule(note, rules)?.category ?? "other";

/** Skips an unknown category (a model invents them) or a pattern the user already has, so a proposal never overwrites a person's rule. */
type RuleAdditions = { readonly added: SpendingRule[]; readonly rejected: string[] };

export const addRules = async (
  db: Db,
  userId: string,
  proposed: readonly { pattern: string; category: string }[],
  source: "ai" | "user",
): Promise<RuleAdditions> => {
  const existing = new Set((await rulesFor(db, userId)).map((rule) => rule.pattern));
  const added: SpendingRule[] = [];
  const rejected: string[] = [];

  for (const candidate of proposed) {
    const pattern = candidate.pattern.trim().toUpperCase();
    if (pattern.length < 3 || !isCategory(candidate.category)) {
      rejected.push(candidate.pattern);
      continue;
    }
    if (existing.has(pattern)) continue;

    await db
      .insert(spendingRules)
      .values({ userId, pattern, category: candidate.category, source })
      .run();
    existing.add(pattern);
    added.push({ pattern, category: candidate.category, source });
  }

  return { added, rejected };
};

/** A rule the person wrote is a decision: the assistant may revise only its own work or a seed. */
const ASSISTANT_MAY_CHANGE: ReadonlySet<string> = new Set(["seed", "ai"]);

type RuleChange =
  | { readonly ok: true; readonly pattern: string; readonly was: Category }
  | { readonly ok: false; readonly reason: "no-such-rule" | "owned-by-user" };

const storedRule = async (
  db: Db,
  userId: string,
  pattern: string,
): Promise<{ readonly category: string; readonly source: string } | undefined> => {
  // Seed rules become rows on the first `rulesFor` call, so a straight read would miss them for a user who never opened Spending.
  await rulesFor(db, userId);
  return (
    await db
      .select({ category: spendingRules.category, source: spendingRules.source })
      .from(spendingRules)
      .where(and(eq(spendingRules.userId, userId), eq(spendingRules.pattern, pattern)))
      .all()
  )[0];
};

/** Re-points a rule at another category (adding never overwrites). Refuses a person's rule and marks the change as the assistant's. */
export const recategoriseRule = async (
  db: Db,
  userId: string,
  pattern: string,
  category: Category,
): Promise<RuleChange> => {
  const target = pattern.trim().toUpperCase();
  const existing = await storedRule(db, userId, target);
  if (existing === undefined) return { ok: false, reason: "no-such-rule" };
  if (!ASSISTANT_MAY_CHANGE.has(existing.source)) return { ok: false, reason: "owned-by-user" };

  await db
    .update(spendingRules)
    .set({ category, source: "ai" })
    .where(and(eq(spendingRules.userId, userId), eq(spendingRules.pattern, target)))
    .run();
  // SAFETY: every stored category is written through `isCategory`.
  return { ok: true, pattern: target, was: existing.category as Category };
};

export const retractRule = async (db: Db, userId: string, pattern: string): Promise<RuleChange> => {
  const target = pattern.trim().toUpperCase();
  const existing = await storedRule(db, userId, target);
  if (existing === undefined) return { ok: false, reason: "no-such-rule" };
  if (!ASSISTANT_MAY_CHANGE.has(existing.source)) return { ok: false, reason: "owned-by-user" };

  await db
    .delete(spendingRules)
    .where(and(eq(spendingRules.userId, userId), eq(spendingRules.pattern, target)))
    .run();
  // SAFETY: as in `recategoriseRule`.
  return { ok: true, pattern: target, was: existing.category as Category };
};

/** Deletes one rule of this user's. Returns whether there was one to delete. */
export const removeRule = async (db: Db, userId: string, pattern: string): Promise<boolean> => {
  const target = pattern.trim().toUpperCase();
  const deleted = await db
    .delete(spendingRules)
    .where(and(eq(spendingRules.userId, userId), eq(spendingRules.pattern, target)))
    .returning({ pattern: spendingRules.pattern })
    .all();
  return deleted.length > 0;
};

// Money a shop gives back is not income: it goes against the category it came from.
const REFUND_LABELS = ["HYVITYS", "PALAUTUS"];

export const isRefund = (note: string): boolean => {
  const upper = note.toUpperCase();
  return REFUND_LABELS.some((label) => upper.includes(label));
};
