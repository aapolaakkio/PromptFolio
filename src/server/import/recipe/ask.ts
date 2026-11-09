import { z } from "zod";

import type { ChatClient, ChatMessage } from "../../chat/runner.ts";
export const FINNISH_CONTEXT =
  "This app serves Finnish customers: the documents come from Finnish banks and brokers, so Finnish law and conventions apply (Finnish number and date formats, Finnish transaction type labels, and Finnish tax rules wherever tax is involved).";

export const RECIPE_MODEL = "claude-opus-5-5";
const MAX_TOKENS = 16000;
const MAX_SAMPLE_CHARS = 40_000;
const MAX_ATTEMPTS = 3;

export type Judged = {
  readonly passed: boolean;
  readonly score: number;
  readonly feedback: string;
};

type Asked<R, Run> = { readonly recipe: R; readonly run: Run; readonly verified: boolean };

/** On failure shows the model what went wrong; null when no attempt read anything. */
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
      : `Invalid answer: ${parsed.error}\nReply with a bare JSON object only.`;
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
        content: `The recipe does not work yet:\n${feedback}\nFix it and reply with the whole recipe.`,
      },
    ];
  }
  return best === null ? null : { recipe: best.recipe, run: best.run, verified: false };
};

const recipeOf = <R>(
  text: string,
  schema: z.ZodType<R>,
): { ok: true; recipe: R } | { ok: false; error: string } => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? { ok: true, recipe: parsed.data }
    : { ok: false, error: z.prettifyError(parsed.error).slice(0, 2000) };
};
