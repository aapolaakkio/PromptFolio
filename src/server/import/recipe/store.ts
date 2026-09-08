import { and, eq } from "drizzle-orm";

import { db } from "../../db/index.ts";
import { importRecipes } from "../../db/schema.ts";
import { parseRecipe, type BankRecipe } from "./types.ts";

/**
 * A stored recipe is re-validated on the way out. A row written by an older
 * shape of the schema is treated as a miss, so the model describes the layout
 * again -- one extra call, never a wrong import.
 */
export const loadRecipe = async (
  userId: string,
  fingerprint: string,
): Promise<BankRecipe | null> => {
  const row = await db
    .select({ recipe: importRecipes.recipe })
    .from(importRecipes)
    .where(and(eq(importRecipes.userId, userId), eq(importRecipes.fingerprint, fingerprint)))
    .get();
  if (!row) return null;
  try {
    return parseRecipe(JSON.parse(row.recipe));
  } catch {
    return null;
  }
};

export const saveRecipe = async (
  userId: string,
  fingerprint: string,
  recipe: BankRecipe,
): Promise<void> => {
  await db
    .insert(importRecipes)
    .values({ userId, fingerprint, kind: "bank", recipe: JSON.stringify(recipe) })
    .onConflictDoUpdate({
      target: [importRecipes.userId, importRecipes.fingerprint],
      set: { recipe: JSON.stringify(recipe) },
    });
};

export const forgetRecipe = async (userId: string, fingerprint: string): Promise<void> => {
  await db
    .delete(importRecipes)
    .where(and(eq(importRecipes.userId, userId), eq(importRecipes.fingerprint, fingerprint)));
};
