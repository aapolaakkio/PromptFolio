import { z } from "zod";

import { maskForFileSample } from "../../chat/mask.ts";
import type { ChatClient, ChatMessage } from "../../chat/runner.ts";

export const FINNISH_CONTEXT =
  "This app serves Finnish customers: the documents come from Finnish banks and brokers, so Finnish law and conventions apply (Finnish number and date formats, Finnish transaction type labels, and Finnish tax rules wherever tax is involved).";

/** Goes with every masked file sample, so a recipe is never written to match the stand-ins. */
export const MASKED_SAMPLE_NOTE =
  "Privacy: in what you are shown, account numbers, personal identity codes, card numbers, phone numbers and email addresses are replaced by stand-ins of the same length: every digit by 0 and every letter by x (an IBAN is shown as xx00 0000 0000 0000 00). The real file has the real characters, and the recipe is run on the real file. Never match a literal 0 or x from the sample: match such values by their form (\\d, [A-Z], a column position), exactly as you would for the real values.";

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

/** On failure shows the model what went wrong; null when no attempt read anything. The model sees the file with account numbers and personal codes blanked; the recipe runs on the real file. */
export const askForRecipe = async <R, Run>(args: {
  readonly client: ChatClient;
  readonly instructions: string;
  readonly sample: string;
  /** A public web page, not the owner's file: sent as it is. */
  readonly publicSample?: true;
  readonly schema: z.ZodType<R>;
  readonly run: (recipe: R) => Run;
  readonly judge: (run: Run) => Judged;
}): Promise<Asked<R, Run> | null> => {
  const shown = (text: string): string =>
    args.publicSample === true ? text : maskForFileSample(text);
  const instructions =
    args.publicSample === true
      ? args.instructions
      : `${args.instructions}\n\n${MASKED_SAMPLE_NOTE}`;
  let messages: readonly ChatMessage[] = [
    { role: "system", content: instructions },
    { role: "user", content: shown(args.sample.slice(0, MAX_SAMPLE_CHARS)) },
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
        content: `The recipe does not work yet:\n${shown(feedback)}\nFix it and reply with the whole recipe.`,
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
