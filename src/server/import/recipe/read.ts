import type { ChatClient } from "../../chat/runner.ts";
import { extractPages } from "../pdf-read.ts";
import { fingerprint } from "./fingerprint.ts";
import { generateRecipe } from "./generate.ts";
import { runRecipe, type RecipeRun } from "./run.ts";
import { forgetRecipe, loadRecipe, saveRecipe } from "./store.ts";
import type { BankRecipe } from "./types.ts";
import { verifyRun } from "./verify.ts";

/**
 * The producer a PDF names itself by, when it names one. Part of the
 * fingerprint because two banks can open with the same words and not the same
 * layout, and one bank's own generator rarely changes between statements.
 */
const producerOf = (bytes: ArrayBuffer): string => {
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 4096));
  return /\/Producer\s*\(([^)]{0,80})\)/.exec(head)?.[1] ?? "";
};

/** The key a document's layout is cached under. Shared with the tests, so both agree. */
export const recipeKey = (bytes: ArrayBuffer, firstPageText: string): string =>
  fingerprint(producerOf(bytes), firstPageText.split("\n"));

/** The stored recipe's run when it still holds up, null when it does not. */
const runStored = (text: string, recipe: BankRecipe): RecipeRun | null => {
  try {
    const run = runRecipe(text, recipe);
    return verifyRun(run).ok ? run : null;
  } catch {
    return null;
  }
};

/**
 * A statement read by whichever recipe applies: the stored one when its
 * fingerprint matches and it still holds up, a freshly described one
 * otherwise. Only a verified recipe is stored, so a bad description costs one
 * import's review and never the next one's.
 */
export const readBankPdfByRecipe = async (
  bytes: ArrayBuffer,
  userId: string,
  client: ChatClient,
): Promise<RecipeRun> => {
  const pages = await extractPages(bytes);
  const text = pages.map((page) => page.text).join("\n");
  const key = recipeKey(bytes, pages[0]?.text ?? "");

  const stored = await loadRecipe(userId, key);
  if (stored !== null) {
    // A stored recipe that no longer fits may fail verification or throw
    // outright (a balance line it can no longer find). Both mean the same
    // thing: forget it and describe the layout again.
    const run = runStored(text, stored);
    if (run !== null) return run;
    await forgetRecipe(userId, key);
  }

  const { recipe, run, verified } = await generateRecipe(text, pages, client);
  if (verified) await saveRecipe(userId, key, recipe);
  return run;
};
