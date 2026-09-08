import { beforeEach, describe, expect, test } from "vitest";

import { db } from "../../db/index.ts";
import { importRecipes, user } from "../../db/schema.ts";
import { OP_STATEMENT_RECIPE } from "./op-reference.ts";
import { forgetRecipe, loadRecipe, saveRecipe } from "./store.ts";

const USER = "recipe-store-user";

beforeEach(async () => {
  await db.delete(importRecipes);
  await db
    .insert(user)
    .values({
      id: USER,
      name: "Testi",
      email: `${USER}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
});

describe("recipe store", () => {
  test("a saved recipe comes back", async () => {
    await saveRecipe(USER, "fp-1", OP_STATEMENT_RECIPE);
    expect(await loadRecipe(USER, "fp-1")).toEqual(OP_STATEMENT_RECIPE);
  });

  test("an unknown fingerprint reads as null", async () => {
    expect(await loadRecipe(USER, "never-seen")).toBeNull();
  });

  test("saving the same fingerprint twice replaces it", async () => {
    await saveRecipe(USER, "fp-1", OP_STATEMENT_RECIPE);
    const changed = { ...OP_STATEMENT_RECIPE, restField: "message" as const };
    await saveRecipe(USER, "fp-1", changed);

    expect((await loadRecipe(USER, "fp-1"))?.restField).toBe("message");
  });

  test("a forgotten recipe is gone", async () => {
    await saveRecipe(USER, "fp-1", OP_STATEMENT_RECIPE);
    await forgetRecipe(USER, "fp-1");

    expect(await loadRecipe(USER, "fp-1")).toBeNull();
  });

  test("another user's fingerprint is not visible", async () => {
    await saveRecipe(USER, "fp-1", OP_STATEMENT_RECIPE);
    expect(await loadRecipe("someone-else", "fp-1")).toBeNull();
  });

  test("a stored row that no longer validates reads as null rather than throwing", async () => {
    await db.insert(importRecipes).values({
      userId: USER,
      fingerprint: "fp-bad",
      kind: "bank",
      recipe: JSON.stringify({ kind: "bank" }),
    });

    expect(await loadRecipe(USER, "fp-bad")).toBeNull();
  });
});
