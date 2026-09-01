import { and, eq } from "drizzle-orm";

import { chunkForInsert, type Db } from "../db/index.ts";
import { spendingRules } from "../db/schema.ts";
import { CATEGORY_LABELS, SEED_RULES, type Category } from "./categories.ts";

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
 * The rules this user's spending is read through. Seeded once, then theirs: a
 * deleted rule stays deleted, and re-seeding on every call would undo that.
 */
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
    // Chunked, and batched so the whole seed still lands or none of it does:
    // there are more seed rules than D1 allows bound variables in one insert.
    const inserts = chunkForInsert(seeds, 4).map((chunk) => db.insert(spendingRules).values(chunk));
    // SAFETY: `db.batch` is typed as a non-empty tuple; SEED_RULES is a
    // non-empty literal, so `chunkForInsert` always returns at least one chunk.
    await db.batch(inserts as [(typeof inserts)[number], ...typeof inserts]);
    return SEED_RULES.map((rule) => ({ ...rule, source: "seed" as const }));
  }

  return stored.flatMap((row) =>
    isCategory(row.category) ? [{ ...row, category: row.category }] : [],
  );
};

/**
 * Which rule a payment falls under. The longest pattern wins, not the first
 * stored: a specific rule must beat a general one whichever was added first.
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
 * Stores rules, skipping an unknown category or a pattern the user already has.
 * Both matter for the assistant: a model will occasionally invent a category,
 * and it must not overwrite a person's rule by proposing the same pattern.
 */
export type RuleAdditions = { readonly added: SpendingRule[]; readonly rejected: string[] };

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

/**
 * A rule the person wrote is a decision, not a guess: the assistant may revise
 * its own work or a seed, never that. Everything it can touch, it can be asked
 * to put back, which is the whole safety property of its write access.
 */
const ASSISTANT_MAY_CHANGE: ReadonlySet<string> = new Set(["seed", "ai"]);

export type RuleChange =
  | { readonly ok: true; readonly pattern: string; readonly was: Category }
  | { readonly ok: false; readonly reason: "no-such-rule" | "owned-by-user" };

const storedRule = async (
  db: Db,
  userId: string,
  pattern: string,
): Promise<{ readonly category: string; readonly source: string } | undefined> => {
  // The built-in rules become rows on the first `rulesFor` call, not at sign-up.
  // Reading the table straight would therefore find nothing at all for a user
  // who has never opened Kulutus -- and report every seed rule as "no such
  // rule" rather than as one that exists and may be changed.
  await rulesFor(db, userId);
  return (
    await db
      .select({ category: spendingRules.category, source: spendingRules.source })
      .from(spendingRules)
      .where(and(eq(spendingRules.userId, userId), eq(spendingRules.pattern, pattern)))
      .all()
  )[0];
};

/**
 * Points a rule at a different category -- the one way to fix a wrong one, since
 * adding never overwrites. Refuses a rule a person wrote, and marks what it does
 * change as the assistant's, so the change stays reviewable.
 */
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
  // SAFETY: every stored category is written through `isCategory`, either by
  // `addRules`, by this function, or by the seed table itself.
  return { ok: true, pattern: target, was: existing.category as Category };
};

/** Deletes a rule the assistant is allowed to touch -- never one the user wrote. */
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

/**
 * What a bank calls money coming back from a shop. Not income: counting it as
 * income inflates what came in and leaves the purchase at full price, so it goes
 * against the category it came from.
 */
const REFUND_LABELS = ["HYVITYS", "PALAUTUS"];

export const isRefund = (note: string): boolean => {
  const upper = note.toUpperCase();
  return REFUND_LABELS.some((label) => upper.includes(label));
};
