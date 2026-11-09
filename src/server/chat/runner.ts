import Anthropic from "@anthropic-ai/sdk";
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaTool,
  BetaWebSearchTool20260318,
} from "@anthropic-ai/sdk/resources/beta";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { HttpError } from "../errors.ts";
import type { JSONSchema } from "zod/v4/core";

import { DEFAULT_CHAT_MODEL } from "./models.ts";
import type { ChatTool } from "./tools.ts";

/** Thinking counts against this too, so it is roomier than an answer needs. */
const MAX_TOKENS = 16000;
/** Tool rounds in one turn. A model still calling tools past this is circling, not working. */
const MAX_ROUNDS = 10;

// A portfolio answer that invents a number is worse than none, so the prompt makes arithmetic the tools' job and "cannot tell" a valid answer.
export const SYSTEM_PROMPT = `You are the investment and personal-finance assistant of the PromptFolio app. You answer in English.

The app serves Finnish customers: their accounts, banks, brokers and taxes are Finnish. Follow Finnish law and Finnish tax rules (for example capital income tax and the deemed acquisition cost) whenever you explain or calculate anything.

You have tools that read figures computed from the user's own portfolio and bank-account transactions. Rules:

1. Base figures always come from the tools, never from memory or guesswork. If a tool gives no figure, say it is not available.
2. You may derive new figures (differences, shares, averages, monthly levels). Use the calculate tool for it and do not calculate in your head: a one-cent error in someone's own finances is an error, not rounding. Briefly say what a derived figure is made of.
3. Always say which date the figures are based on (the tool's 'asOf'). If a tool returns 'stale': true, say that some prices are out of date.
4. If a tool returns null or says a figure cannot be calculated, say so directly.
5. Spending categories come from rules that do not know every shop. Unknown ones show up in the category Other. You may save rules with the save_spending_rules tool, fix a wrong category with the update_spending_rule tool, and delete an over-broad rule with the remove_spending_rule tool. These are the only tools that write, and they write only the categorisation -- never transactions. Rules: save only names you saw in tool results, do not invent payees, always say what you saved or changed, and if a tool says a rule belongs to the user, say it can be changed on the Spending page. Before saving several at once, say what you are about to save.
6. You give no investment advice and make no return forecasts. You describe the state and history of the portfolio and finances.
7. Tax figures are taxable income, not the amount of tax. Do not say how much tax will be paid and do not use a tax rate: the 30/34 % capital-income threshold also depends on income these tools cannot see. If a share savings account withdrawal is 'blocked', give the reason and do not guess a figure. Remind the user that the figures are meant for checking the pre-filled tax return.
8. About the target allocation you may report the difference and what correcting it would take, but you do not urge buying or selling. If you mention a sale, also say how much gain it would realise -- that is gain, not tax. Withheld capital income tax is not a fee.
9. Answer briefly. Give figures in euros with two decimals.`;

export type ChatEvent =
  | { readonly type: "conversation"; readonly id: number }
  | { readonly type: "tool"; readonly name: string }
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "answer"; readonly text: string }
  | { readonly type: "error"; readonly message: string };

export type ToolCall = { readonly id: string; readonly name: string; readonly arguments: string };

export type ModelReply = {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly blocks?: readonly BetaContentBlock[];
};

export type ChatMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly tool_calls?: readonly ToolCall[];
      /** When present, sent back instead of `content` and `tool_calls`. */
      readonly blocks?: readonly BetaContentBlock[];
    }
  | { readonly role: "tool"; readonly content: string; readonly tool_call_id: string };

export type ToolDefinition = BetaTool;
export type ServerTool = BetaWebSearchTool20260318;

export type TurnParams = {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly (ToolDefinition | ServerTool)[];
  readonly response_format?: {
    readonly type: "json_schema";
    readonly json_schema: JSONSchema.BaseSchema;
  };
};

/** The one call the runner needs, as a shape so tests drive the loop against a scripted model. */
type RunOptions = {
  readonly signal?: AbortSignal;
  readonly onDelta?: (text: string) => void;
};

export type ChatClient = {
  readonly run: (params: TurnParams, options?: RunOptions) => Promise<ModelReply>;
};

/** Messages API shape: system text goes top-level; a tool result is a user turn, and consecutive user turns are joined by the API. */
const toApiMessages = (messages: readonly ChatMessage[]): BetaMessageParam[] =>
  messages.flatMap((message): BetaMessageParam[] => {
    switch (message.role) {
      case "system":
        return [];
      case "user":
        return [{ role: "user", content: message.content }];
      case "tool":
        return [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: message.tool_call_id, content: message.content },
            ],
          },
        ];
      case "assistant": {
        if (message.blocks !== undefined)
          return [{ role: "assistant", content: [...message.blocks] }];
        const calls = (message.tool_calls ?? []).map((call) => ({
          type: "tool_use" as const,
          id: call.id,
          name: call.name,
          input: parseArguments(call.arguments),
        }));
        const text =
          message.content === "" ? [] : [{ type: "text" as const, text: message.content }];
        return [{ role: "assistant", content: [...text, ...calls] }];
      }
    }
  });

const ToolInput = z.json();
const parseArguments = (text: string): z.infer<typeof ToolInput> =>
  ToolInput.parse(JSON.parse(text.trim() === "" ? "{}" : text));

const systemOf = (messages: readonly ChatMessage[]): string =>
  messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

const toReply = (message: BetaMessage): ModelReply => {
  if (message.stop_reason === "refusal") throw new Error(REFUSED);
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
  // A reply cut off at max_tokens may hold a call whose input never finished.
  const toolCalls =
    message.stop_reason === "max_tokens"
      ? []
      : message.content.flatMap((block) =>
          block.type === "tool_use"
            ? [{ id: block.id, name: block.name, arguments: JSON.stringify(block.input) }]
            : [],
        );
  return { text, toolCalls, blocks: message.content };
};

const REFUSED = "The model refused to answer this request";

const EFFORT = "medium";

/** Claude via Cloudflare AI Gateway when `AI_GATEWAY_ID` is set, else direct. Built per call so the Worker serves the rest without a key. */
export const createClient = (fetchImpl?: typeof fetch): ChatClient => {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new HttpError(503, "ANTHROPIC_API_KEY is missing from the server settings");

  return {
    run: async (params, options) => {
      const baseURL = env.AI_GATEWAY_ID
        ? await env.AI.gateway(env.AI_GATEWAY_ID).getUrl("anthropic")
        : undefined;
      const gatewayToken = env.AI_GATEWAY_TOKEN;
      const anthropic = new Anthropic({
        apiKey,
        baseURL,
        fetch: fetchImpl,
        defaultHeaders: {
          "cf-aig-authorization": baseURL && gatewayToken ? `Bearer ${gatewayToken}` : null,
          // AI Gateway does not recognise `Authorization: Bearer` as an Anthropic key; `x-api-key` it does.
          "x-api-key": apiKey,
          authorization: null,
        },
      });
      const format = params.response_format;
      // ponytail: Haiku has no server-side fallback, so a refusal there just surfaces.
      const fallback = !params.model.startsWith("claude-haiku");
      const stream = anthropic.beta.messages.stream(
        {
          model: params.model,
          max_tokens: params.max_tokens,
          system: systemOf(params.messages),
          messages: toApiMessages(params.messages),
          thinking: { type: "adaptive" },
          output_config: {
            effort: EFFORT,
            format:
              format === undefined
                ? undefined
                : { type: "json_schema", schema: transformJSONSchema(format.json_schema) },
          },
          tools: params.tools.length === 0 ? undefined : [...params.tools],
          betas: fallback ? ["server-side-fallback-2026-07-01"] : undefined,
          fallbacks: fallback ? "default" : undefined,
        },
        options?.signal ? { signal: options.signal } : undefined,
      );
      const onDelta = options?.onDelta;
      if (onDelta) stream.on("text", onDelta);
      return toReply(await stream.finalMessage());
    },
  };
};

export const toolDefinitions = (tools: readonly ChatTool[]): ToolDefinition[] =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // SAFETY: every tool schema is a z.object, whose JSON schema is `type: "object"`.
    input_schema: z.toJSONSchema(tool.schema, {
      io: "input",
      unrepresentable: "any",
    }) as ToolDefinition["input_schema"],
  }));

/** Runs one tool call. Every failure comes back as a message, since a thrown tool would kill the turn. */
const runTool = async (tools: readonly ChatTool[], call: ToolCall): Promise<string> => {
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (tool === undefined) return JSON.stringify({ error: `Unknown tool: ${call.name}` });
  try {
    const raw: unknown = JSON.parse(call.arguments.trim() === "" ? "{}" : call.arguments);
    return JSON.stringify(await tool.run(tool.schema.parse(raw)));
  } catch (cause) {
    return JSON.stringify({
      error: cause instanceof Error ? cause.message : "Tool failed",
    });
  }
};

/** A model call whose text pieces can be iterated as they arrive; ends when the reply settles. */
const withDeltas = (client: ChatClient, params: TurnParams, signal?: AbortSignal) => {
  let queue: readonly string[] = [];
  let settled = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    const waiting = wake;
    wake = null;
    waiting?.();
  };
  const onDelta = (text: string) => {
    queue = [...queue, text];
    notify();
  };
  const options: RunOptions = signal ? { signal, onDelta } : { onDelta };
  const reply = client.run(params, options).finally(() => {
    settled = true;
    notify();
  });
  // A rejection is surfaced by `await reply` in the caller, after the deltas.
  reply.catch(() => undefined);
  const deltas = {
    async *[Symbol.asyncIterator]() {
      while (!settled || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        const batch = queue;
        queue = [];
        yield* batch;
      }
    },
  };
  return { deltas, reply };
};

/** One turn: an event per tool dispatched, then one answer. The loop is ours: ask, run the tools called, hand results back, until it answers in words. */
export async function* runTurn(
  client: ChatClient,
  tools: readonly ChatTool[],
  history: readonly { role: "user" | "assistant"; content: string }[],
  signal?: AbortSignal,
  model: string = DEFAULT_CHAT_MODEL,
): AsyncGenerator<ChatEvent> {
  const definitions = toolDefinitions(tools);
  let messages: readonly ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...history];
  let last = "";
  let answered = false;

  for (let round = 0; round < MAX_ROUNDS && !answered; round++) {
    // The client's signal: a dropped connection cancels the request, since an unread tool loop still costs tokens.
    const streamed = withDeltas(
      client,
      { model, max_tokens: MAX_TOKENS, messages, tools: definitions },
      signal,
    );
    for await (const piece of streamed.deltas) yield { type: "delta", text: piece };
    const reply = await streamed.reply;
    if (signal?.aborted === true) return;
    if (reply.text !== "") last = reply.text;
    if (reply.toolCalls.length === 0) {
      answered = true;
      break;
    }
    messages = [
      ...messages,
      reply.blocks === undefined
        ? { role: "assistant", content: reply.text, tool_calls: reply.toolCalls }
        : {
            role: "assistant",
            content: reply.text,
            tool_calls: reply.toolCalls,
            blocks: reply.blocks,
          },
    ];
    for (const call of reply.toolCalls) {
      yield { type: "tool", name: call.name };
      messages = [
        ...messages,
        { role: "tool", tool_call_id: call.id, content: await runTool(tools, call) },
      ];
    }
  }

  yield {
    type: "answer",
    text: answered || last !== "" ? last : "I could not finish the answer: too many tool calls.",
  };
}
