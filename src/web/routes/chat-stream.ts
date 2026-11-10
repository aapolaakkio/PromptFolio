import { z } from "zod";

import { ChatChartSchema } from "../../server/chat/chart-schema.ts";
import type { ChatModel } from "../../server/chat/models.ts";
import type { PageContext } from "../../server/chat/page-context.ts";
import { ProposalSchema } from "../../server/chat/proposal-schema.ts";
import { SearchEventSchemas } from "../../server/chat/search-schema.ts";
import { askTurn } from "../server/chat.ts";

/** Chat events validated at the boundary; an unrecognised event is dropped, not rendered next to real figures. */
export const ChatEventSchema = z.union([
  z.object({ type: z.literal("conversation"), id: z.number().int().positive() }),
  z.object({ type: z.literal("tool"), name: z.string() }),
  z.object({ type: z.literal("proposal"), proposal: ProposalSchema }),
  ChatChartSchema.extend({ type: z.literal("chart") }),
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("answer"), text: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
  ...SearchEventSchemas,
]);

export type ChatEvent = z.infer<typeof ChatEventSchema>;

/** Splits a growing SSE buffer into whole events and returns the remainder; a chunk can end mid-JSON. */
export const takeEvents = (buffer: string) => {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const events = parts.flatMap((part): ChatEvent[] => {
    const line = part.split("\n").find((l) => l.startsWith("data: "));
    if (!line) return [];
    const raw: unknown = JSON.parse(line.slice("data: ".length));
    const parsed = ChatEventSchema.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
  return { events, rest };
};

type AskBody = {
  message: string;
  conversationId?: number;
  model?: ChatModel;
  context?: PageContext;
  webSearch?: boolean;
};
type Turn = (body: AskBody) => Promise<Response>;

// `fetch`, not `EventSource`: the question travels in the body, not a URL and its access logs.
export async function* askChat(
  body: AskBody,
  turn: Turn = (data) => askTurn({ data }),
): AsyncGenerator<ChatEvent> {
  const response = await turn(body);

  if (!response.ok || !response.body) {
    // The server's own message when it sent one (a missing API key, a refused question).
    const failure: unknown = await response.json().catch(() => null);
    const parsed = z.object({ error: z.string() }).safeParse(failure);
    yield {
      type: "error",
      message: parsed.success ? parsed.data.error : "Could not fetch the answer",
    };
    return;
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const { events, rest } = takeEvents(buffer);
    buffer = rest;
    yield* events;
  }
}
