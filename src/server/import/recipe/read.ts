import type { ChatClient } from "../../chat/runner.ts";
import { extractPages } from "../pdf-read.ts";
import { fingerprint } from "./fingerprint.ts";
import { generateRecipe } from "./generate.ts";
import { RecipeTimeoutError, runRecipe, type RecipeRun } from "./run.ts";
import { forgetRecipe, loadRecipe, saveRecipe } from "./store.ts";
import type { BankRecipe } from "./types.ts";
import { verifyRun } from "./verify.ts";

const producerOf = (bytes: ArrayBuffer): string => {
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 4096));
  return /\/Producer\s*\(([^)]{0,80})\)/.exec(head)?.[1] ?? "";
};

export const recipeKey = (bytes: ArrayBuffer, firstPageText: string): string =>
  fingerprint(producerOf(bytes), firstPageText.split("\n"));

type StoredAttempt = { readonly run: RecipeRun | null; readonly fatal: Error | null };

/** A time-budget failure is `fatal`: it would recur on every import. */
const runStored = (text: string, recipe: BankRecipe, budgetMs?: number): StoredAttempt => {
  try {
    const run =
      budgetMs === undefined ? runRecipe(text, recipe) : runRecipe(text, recipe, budgetMs);
    return { run: verifyRun(run).ok ? run : null, fatal: null };
  } catch (cause) {
    return { run: null, fatal: cause instanceof RecipeTimeoutError ? cause : null };
  }
};

/** Only a verified recipe is stored. */
export const readBankPdfByRecipe = async (
  bytes: ArrayBuffer,
  userId: string,
  client: ChatClient,
  storedBudgetMs?: number,
): Promise<RecipeRun> => {
  const pages = await extractPages(bytes);
  const text = pages.map((page) => page.text).join("\n");
  const key = recipeKey(bytes, pages[0]?.text ?? "");

  const stored = await loadRecipe(userId, key);
  if (stored !== null) {
    // A stored recipe that no longer fits may fail verification or throw: forget it and describe again.
    const { run, fatal } = runStored(text, stored, storedBudgetMs);
    if (run !== null) return run;
    await forgetRecipe(userId, key);
    if (fatal !== null) throw fatal;
  }

  const { recipe, run, verified } = await generateRecipe(text, pages, client);
  if (verified) await saveRecipe(userId, key, recipe);
  return run;
};
