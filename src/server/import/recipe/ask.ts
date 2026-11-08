import { z } from "zod";

import type { ChatClient, ChatMessage } from "../../chat/runner.ts";
/** The model that writes every recipe. */
export const RECIPE_MODEL = "claude-opus-5-5";
const MAX_TOKENS = 16000;
/**
 * The most of a document a model is shown. A sample is a layout's first rows;
 * a line long enough to blow past this is not a layout worth paying for.
 */
const MAX_SAMPLE_CHARS = 40_000;
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
    { role: "user", content: args.sample.slice(0, MAX_SAMPLE_CHARS) },
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
    const parsed = recipeOf(reply.text, args.schema);
    let feedback = parsed.ok
      ? ""
      : `Vastaus ei kelpaa: ${parsed.error}\nVastaa pelkällä JSON-oliolla.`;
    if (parsed.ok) {
      const run = args.run(parsed.recipe);
      const judged = args.judge(run);
      if (judged.passed) return { recipe: parsed.recipe, run, verified: true };
      if (judged.score > (best?.score ?? 0))
        best = { recipe: parsed.recipe, run, score: judged.score };
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

/** The reply as a recipe, or what was wrong with it -- told back to the model. */
const recipeOf = <R>(
  text: string,
  schema: z.ZodType<R>,
): { ok: true; recipe: R } | { ok: false; error: string } => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "ei JSON-muotoa" };
  }
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? { ok: true, recipe: parsed.data }
    : { ok: false, error: z.prettifyError(parsed.error).slice(0, 2000) };
};
