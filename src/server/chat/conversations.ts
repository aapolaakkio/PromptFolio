import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/index.ts";
import { chatMessages, conversations } from "../db/schema.ts";
import { HttpError } from "../errors.ts";
import { CHAT_MODEL_IDS, DEFAULT_CHAT_MODEL } from "./models.ts";
import { runTurn, type ChatEvent, type ChatClient, createClient } from "./runner.ts";
import { buildChatTools } from "./tools.ts";

export const Ask = z
  .object({
    conversationId: z.number().int().positive().optional(),
    message: z.string().trim().min(1, "Kysymys ei voi olla tyhjä").max(2000),
    /** Which model answers this turn: the picker on the chat page, for trying them out. */
    model: z.enum(CHAT_MODEL_IDS).optional(),
  })
  .strict();

export const ConversationId = z.object({ id: z.number().int().positive() });

/** Tests inject their own client and never reach the binding. */
const resolveClient = (): ChatClient => createClient();

let clientOverride: ChatClient | null = null;
export const _setChatClient = (client: ChatClient | null): void => {
  clientOverride = client;
};

// Ownership-first, and 404 rather than 403: telling a stranger that
// conversation 7 exists but is not theirs is itself a leak.
const ownedConversation = async (userId: string, id: number) => {
  const row = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
    .get();
  if (!row) throw new HttpError(404, "Keskustelua ei löytynyt");
  return row;
};

const titleFrom = (message: string): string =>
  message.length <= 60 ? message : `${message.slice(0, 57)}...`;

const historyFor = (conversationId: number) =>
  db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, conversationId))
    .orderBy(asc(chatMessages.id))
    .all();

export const listConversations = async (userId: string) =>
  (
    await db
      .select({
        id: conversations.id,
        title: conversations.title,
        createdAt: conversations.createdAt,
      })
      .from(conversations)
      .where(eq(conversations.userId, userId))
      .orderBy(desc(conversations.id))
      .all()
  ).map((row) => ({
    id: row.id,
    title: row.title ?? "Keskustelu",
    createdAt: row.createdAt.toISOString(),
  }));

export const conversationMessages = async (userId: string, id: number) => {
  // Awaited, not fired and forgotten: this is the ownership check, and a
  // rejected promise nobody waits for lets the messages be returned anyway.
  await ownedConversation(userId, id);
  return await historyFor(id);
};

export const deleteConversation = async (userId: string, id: number): Promise<void> => {
  await ownedConversation(userId, id);
  await db.delete(conversations).where(eq(conversations.id, id)).run();
};

const sse = (event: ChatEvent): string => `data: ${JSON.stringify(event)}\n\n`;

/**
 * Runs one turn, yielding SSE bytes. Everything that can refuse the turn --
 * a missing key, someone else's thread, an empty question -- throws before the
 * stream exists, so those stay a status code rather than a mid-stream surprise.
 */
export const startTurn = async (
  userId: string,
  input: z.infer<typeof Ask>,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> => {
  const { conversationId, message, model = DEFAULT_CHAT_MODEL } = Ask.parse(input);
  const client = clientOverride ?? resolveClient();

  const conversation =
    conversationId === undefined
      ? await db
          .insert(conversations)
          .values({ userId, title: titleFrom(message) })
          .returning()
          .get()
      : await ownedConversation(userId, conversationId);
  if (conversation === undefined) throw new HttpError(500, "Keskustelun luonti epäonnistui");

  // Stored before the model runs, so a turn that fails mid-way leaves the
  // thread showing what was asked rather than losing it.
  await db
    .insert(chatMessages)
    .values({ conversationId: conversation.id, role: "user", content: message })
    .run();

  const history = await historyFor(conversation.id);
  const tools = buildChatTools(db, userId);
  const used: string[] = [];

  let open = true;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      // A browser that navigates away closes the stream under us, and
      // enqueueing into a closed controller throws. Dropping the event is
      // right -- there is no longer anyone to send it to.
      const send = (event: ChatEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(sse(event)));
        } catch {
          open = false;
        }
      };
      send({ type: "conversation", id: conversation.id });
      try {
        for await (const event of runTurn(client, tools, history, signal, model)) {
          if (event.type === "tool") used.push(event.name);
          if (event.type === "answer") {
            await db
              .insert(chatMessages)
              .values({
                conversationId: conversation.id,
                role: "assistant",
                content: event.text,
                toolCalls: used.length === 0 ? null : JSON.stringify(used),
              })
              .run();
          }
          send(event);
        }
      } catch (cause) {
        if (!signal.aborted) {
          // The full error is for the server log only: an SDK error can carry
          // request detail the browser has no business seeing.
          console.error("Chat turn failed", cause);
          send({ type: "error", message: "Vastauksen haku epäonnistui" });
        }
      } finally {
        if (open) controller.close();
      }
    },

    cancel() {
      open = false;
    },
  });
};
