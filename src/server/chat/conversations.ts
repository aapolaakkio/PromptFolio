import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../db/index.ts";
import { chatMessages, conversations } from "../db/schema.ts";
import { HttpError } from "../errors.ts";
import { runTurn, type ChatEvent, type ToolRunnerClient, createClient } from "./runner.ts";
import { buildChatTools } from "./tools.ts";

const { db } = getDb();

export const Ask = z
  .object({
    conversationId: z.number().int().positive().optional(),
    message: z.string().trim().min(1, "Kysymys ei voi olla tyhjä").max(2000),
  })
  .strict();

export const ConversationId = z.object({ id: z.number().int().positive() });

/**
 * Built per turn rather than at import time so the server still starts without
 * a key: chat is one feature of a portfolio app, not a precondition for opening
 * it. Tests inject their own client and never reach this path.
 */
const resolveClient = (): ToolRunnerClient => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new HttpError(503, "ANTHROPIC_API_KEY puuttuu palvelimen asetuksista");
  return createClient(apiKey);
};

let clientOverride: ToolRunnerClient | null = null;
export const _setChatClient = (client: ToolRunnerClient | null): void => {
  clientOverride = client;
};

// Ownership-first, and 404 rather than 403: telling a stranger that
// conversation 7 exists but is not theirs is itself a leak.
const ownedConversation = (userId: string, id: number) => {
  const row = db
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

export const listConversations = (userId: string) =>
  db
    .select({
      id: conversations.id,
      title: conversations.title,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.id))
    .all()
    .map((row) => ({
      id: row.id,
      title: row.title ?? "Keskustelu",
      createdAt: row.createdAt.toISOString(),
    }));

export const conversationMessages = (userId: string, id: number) => {
  ownedConversation(userId, id);
  return historyFor(id);
};

export const deleteConversation = (userId: string, id: number): void => {
  ownedConversation(userId, id);
  db.delete(conversations).where(eq(conversations.id, id)).run();
};

const sse = (event: ChatEvent): string => `data: ${JSON.stringify(event)}\n\n`;

/**
 * Runs one turn, yielding SSE bytes. Everything that can refuse the turn --
 * a missing key, someone else's thread, an empty question -- throws before the
 * stream exists, so those stay a status code rather than a mid-stream surprise.
 */
export const startTurn = (
  userId: string,
  input: z.infer<typeof Ask>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> => {
  const { conversationId, message } = Ask.parse(input);
  const client = clientOverride ?? resolveClient();

  const conversation =
    conversationId === undefined
      ? db
          .insert(conversations)
          .values({ userId, title: titleFrom(message) })
          .returning()
          .get()
      : ownedConversation(userId, conversationId);

  // Stored before the model runs, so a turn that fails mid-way leaves the
  // thread showing what was asked rather than losing it.
  db.insert(chatMessages)
    .values({ conversationId: conversation.id, role: "user", content: message })
    .run();

  const history = historyFor(conversation.id);
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
        for await (const event of runTurn(client, tools, history, signal)) {
          if (event.type === "tool") used.push(event.name);
          if (event.type === "answer") {
            db.insert(chatMessages)
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
