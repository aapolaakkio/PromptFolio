import type { ChatClient, ChatMessage } from "../../chat/runner.ts";
import type { PdfPage } from "../pdf-read.ts";
import { FINNISH_CONTEXT, RECIPE_MODEL } from "./ask.ts";
import { OP_STATEMENT_RECIPE } from "./op-reference.ts";
import type { RecipeRun } from "./run.ts";
import type { BankRecipe } from "./types.ts";
import { createVerifySession, runVerifyCall, verifyToolDefinition } from "./verify-tool.ts";

const MAX_TOKENS = 16000;
const TAIL_LINES = 15;
const MAX_ROUNDS = 10;
const KEEP_ATTEMPTS = 2;

const NO_ANSWER = "The model did not describe the file format";

export const sampleFor = (pages: readonly PdfPage[]): string => {
  const first = pages[0];
  const last = pages.length > 1 ? pages.at(-1) : undefined;
  const tail = last?.text.split("\n").slice(-TAIL_LINES).join("\n");
  return [
    `--- page ${first?.number ?? 1} ---\n${first?.text ?? ""}`,
    tail === undefined ? "" : `--- last page (end) ---\n${tail}`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
};

/** Deliberately mechanical: no layout advice (a model that follows it stops looking). */
const INSTRUCTIONS = `${FINNISH_CONTEXT}

You receive the text content of a bank statement. Do not extract the transactions. Instead, describe the structure of the file as a JSON object that the program runs over the whole file.

This is how the program runs a recipe:
- Lines are trimmed. Every line matching a skip pattern is removed.
- A line matching the recordStart pattern starts a transaction. The lines after it, up to the next recordStart, are that transaction's block.
- Every continuation pattern is run once against the block, with its lines joined by newlines: a pattern may span several lines, but matches only ONCE per block.
- restField receives the first line of the block that no pattern took.
- Named groups are fields, read from any pattern of the same block: date, amount (or debit and credit), label, counterparty, message, externalId. No field has a place of its own. recordStart's own group wins over a continuation's.
- If the statement prints the account balance after every row, name it with the group balance. The check reads it: it is the only way to notice a single misread row, because an error and its mirror image cancel out in the sums.
- header patterns are searched across the whole file, from the group (?<value>...). They must not match transaction lines.

How to work:
- Call the verify_recipe tool with your proposal. It runs the recipe over the whole file and reports what came out: unrecognised lines, skipped lines that look like transactions, the balance check and the first three extracted transactions.
- Read the result and work out yourself what is wrong. sampleRows shows which fields the values landed in: an empty counterparty or a message in the wrong field means a wrong recipe even if the balance matches.
- When the result is ok: true, the work is done. Do not call again.
- Do not write the recipe in your reply as text: give it to the verify_recipe tool.

Example from another bank:
${JSON.stringify(OP_STATEMENT_RECIPE)}`;

/** Only what the TOOL verified counts; with none, the most complete reading is returned as an unverified draft. */
export const generateRecipe = async (
  text: string,
  pages: readonly PdfPage[],
  client: ChatClient,
): Promise<{ recipe: BankRecipe; run: RecipeRun; verified: boolean }> => {
  const session = createVerifySession(text);
  const opening: readonly ChatMessage[] = [
    { role: "system", content: INSTRUCTIONS },
    { role: "user", content: sampleFor(pages) },
  ];
  const attempts: (readonly ChatMessage[])[] = [];

  for (let round = 0; round < MAX_ROUNDS && session.verified() === null; round += 1) {
    const reply = await client.run({
      model: RECIPE_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [...opening, ...attempts.slice(-KEEP_ATTEMPTS).flat()],
      tools: [verifyToolDefinition],
    });
    // Words instead of a call: nothing to check, and asking again would repeat the reply.
    if (reply.toolCalls.length === 0) break;
    const attempt: ChatMessage[] = [
      { role: "assistant", content: reply.text, tool_calls: reply.toolCalls },
    ];
    for (const call of reply.toolCalls) {
      const content = await runVerifyCall(session, call);
      attempt.push({ role: "tool", tool_call_id: call.id, content });
      if (session.verified() !== null) break;
    }
    attempts.push(attempt);
  }

  const verified = session.verified();
  if (verified !== null) return { recipe: verified.recipe, run: verified.run, verified: true };
  const best = session.best();
  if (best !== null) return { recipe: best.recipe, run: best.run, verified: false };
  throw new Error(session.lastError() ?? NO_ANSWER);
};
