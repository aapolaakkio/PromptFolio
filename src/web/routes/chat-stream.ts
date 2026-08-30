import { z } from "zod";

import { askTurn } from "../server/chat.ts";

/**
 * The server's chat events, validated at the boundary like every other
 * response this app reads. An unrecognised event is dropped rather than
 * rendered: the alternative is putting whatever arrived on screen next to real
 * portfolio figures.
 */
export const ChatEventSchema = z.union([
  z.object({ type: z.literal("conversation"), id: z.number().int().positive() }),
  z.object({ type: z.literal("tool"), name: z.string() }),
  z.object({ type: z.literal("answer"), text: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export type ChatEvent = z.infer<typeof ChatEventSchema>;

/**
 * Splits a growing SSE buffer into whole events, returning what is left over.
 *
 * Kept separate from the reader because a chunk boundary can fall anywhere --
 * including mid-JSON -- and getting that wrong shows the user half a number.
 * Pure, so it can be tested without a DOM or a server.
 */
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

type AskBody = { message: string; conversationId?: number };
type Turn = (body: AskBody) => Promise<Response>;

// `fetch` under the hood rather than `EventSource` because the question travels
// in the request body -- EventSource can only GET, which would put a user's
// question in a URL and from there into every access log.
export async function* askChat(
  body: AskBody,
  turn: Turn = (data) => askTurn({ data }),
): AsyncGenerator<ChatEvent> {
  const response = await turn(body);

  if (!response.ok || !response.body) {
    // The server's own Finnish message when it sent one (a missing API key, a
    // refused question); a generic line when the body is not ours to read.
    const failure: unknown = await response.json().catch(() => null);
    const parsed = z.object({ error: z.string() }).safeParse(failure);
    yield {
      type: "error",
      message: parsed.success ? parsed.data.error : "Vastauksen haku epäonnistui",
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
