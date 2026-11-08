import { z } from "zod";

import type { ChatClient, ChatMessage } from "../../chat/runner.ts";
/** The model that writes every recipe. */
export const RECIPE_MODEL = "claude-opus-5-5";
const MAX_TOKENS = 16000;
/** Attempts at a recipe before settling for the best one, unsaved. */
const MAX_ATTEMPTS = 3;

/** What a recipe did when run over the whole document. */
export type Judged = {
  /** True when every row read and nothing the recipe named was missing. */
  readonly passed: boolean;
  /** How much it read; the best partial recipe is the one that read the most. */
  readonly score: number;
  /** What to tell the model when it did not pass. */
  readonly feedback: string;
};

export type Asked<R, Run> = { readonly recipe: R; readonly run: Run; readonly verified: boolean };

/**
 * Asks for a recipe as structured output, runs it over the whole document, and
 * on failure shows the model what went wrong. The conversation only grows, so
 * each retry sees its own earlier answer and what that answer could not read.
 * Null when no attempt produced a recipe that read anything at all.
 */
export const askForRecipe = async <R, Run>(args: {
  readonly client: ChatClient;
  readonly instructions: string;
  readonly sample: string;
  readonly schema: z.ZodType<R>;
  readonly run: (recipe: R) => Run;
  readonly judge: (run: Run) => Judged;
}): Promise<Asked<R, Run> | null> => {
  let messages: readonly ChatMessage[] = [
    { role: "system", content: args.instructions },
    { role: "user", content: args.sample },
  ];
  let best: { recipe: R; run: Run; score: number } | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const reply = await args.client.run({
      model: RECIPE_MODEL,
      max_tokens: MAX_TOKENS,
      messages,
      tools: [],
      response_format: { type: "json_schema", json_schema: z.toJSONSchema(args.schema) },
    });
    const recipe = recipeOf(reply.text, args.schema);
    let feedback = "Vastaus ei ollut kelvollinen kuvaus. Vastaa pelkällä JSON-oliolla.";
    if (recipe !== null) {
      const run = args.run(recipe);
      const judged = args.judge(run);
      if (judged.passed) return { recipe, run, verified: true };
      if (judged.score > (best?.score ?? 0)) best = { recipe, run, score: judged.score };
      feedback = judged.feedback;
    }
    messages = [
      ...messages,
      { role: "assistant", content: reply.text },
      {
        role: "user",
        content: `Kuvaus ei vielä toimi:\n${feedback}\nKorjaa ja vastaa koko kuvauksella.`,
      },
    ];
  }
  return best === null ? null : { recipe: best.recipe, run: best.run, verified: false };
};

/** The reply's JSON, or null when the model wrote something the schema refuses. */
const recipeOf = <R>(text: string, schema: z.ZodType<R>): R | null => {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
