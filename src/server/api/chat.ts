import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { requireUser } from "../auth-guard";
import { runTurn, type ChatEvent, type ToolRunnerClient, createClient } from "../chat/runner";
import { buildChatTools } from "../chat/tools";
import { getDb } from "../db";
import { chatMessages, conversations } from "../db/schema";
import { HttpError, handle, json } from "../http";

const { db } = getDb();

const AskSchema = z
  .object({
    conversationId: z.number().int().positive().optional(),
    message: z.string().trim().min(1, "Kysymys ei voi olla tyhjä").max(2000),
  })
  .strict();

/**
 * The client is built per request rather than at import time so the server
 * still starts without a key -- chat is one feature of a portfolio app, not a
 * precondition for opening it. Tests inject their own client and never reach
 * this path.
 */
const resolveClient = (): ToolRunnerClient => {
  const apiKey = Bun.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new HttpError(503, "ANTHROPIC_API_KEY puuttuu palvelimen asetuksista");
  return createClient(apiKey);
};

let clientOverride: ToolRunnerClient | null = null;
export const _setChatClient = (client: ToolRunnerClient | null): void => {
  clientOverride = client;
};

/**
 * Loads a conversation the caller owns, or refuses. Like every other resource
 * in this app the check is ownership-first and answers 404, never 403: telling
 * a stranger that conversation 7 exists but is not theirs is itself a leak.
 */
const ownedConversation = (id: number, userId: string) => {
  const row = db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
    .get();
  if (!row) throw new HttpError(404, "Keskustelua ei löytynyt");
  return row;
};

/** A thread's title is its first question, trimmed to something a list can show. */
const titleFrom = (message: string): string =>
  message.length <= 60 ? message : `${message.slice(0, 57)}...`;

const historyFor = (conversationId: number) =>
  db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, conversationId))
    .orderBy(asc(chatMessages.id))
    .all();

const sse = (event: ChatEvent): string => `data: ${JSON.stringify(event)}\n\n`;

export const chatRoutes = {
  "/api/chat/conversations": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      const rows = db
        .select({
          id: conversations.id,
          title: conversations.title,
          createdAt: conversations.createdAt,
        })
        .from(conversations)
        .where(eq(conversations.userId, userId))
        .orderBy(desc(conversations.id))
        .all();
      return json({
        conversations: rows.map((row) => ({
          id: row.id,
          title: row.title ?? "Keskustelu",
          createdAt: row.createdAt.toISOString(),
        })),
      });
    }),
  },

  "/api/chat/conversations/:id": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      const id = z.coerce
        .number()
        .int()
        .positive()
        .parse(new URL(request.url).pathname.split("/").at(-1));
      ownedConversation(id, userId);
      return json({ messages: historyFor(id) });
    }),

    DELETE: handle(async (request) => {
      const { userId } = await requireUser(request);
      const id = z.coerce
        .number()
        .int()
        .positive()
        .parse(new URL(request.url).pathname.split("/").at(-1));
      ownedConversation(id, userId);
      db.delete(conversations).where(eq(conversations.id, id)).run();
      return json({ ok: true });
    }),
  },

  "/api/chat": {
    POST: handle(async (request) => {
      const { userId } = await requireUser(request);
      const { conversationId, message } = AskSchema.parse(await request.json());
      const client = clientOverride ?? resolveClient();

      const conversation =
        conversationId === undefined
          ? db
              .insert(conversations)
              .values({ userId, title: titleFrom(message) })
              .returning()
              .get()
          : ownedConversation(conversationId, userId);

      // The question is stored before the model runs, so a turn that fails
      // mid-way leaves the thread showing what was asked rather than losing it.
      db.insert(chatMessages)
        .values({
          conversationId: conversation.id,
          role: "user",
          content: message,
        })
        .run();

      const history = historyFor(conversation.id);
      const tools = buildChatTools(db, userId);
      const used: string[] = [];

      // Declared outside the stream so `cancel` below can see the same flag
      // `start` writes through.
      let open = true;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          // A browser that navigates away closes the stream under us, and
          // enqueueing into a closed controller throws. Dropping the event is
          // the right answer -- there is no longer anyone to send it to -- so
          // this must not become an error the turn reports.
          const send = (event: ChatEvent) => {
            if (!open) return;
            try {
              controller.enqueue(encoder.encode(sse(event)));
            } catch {
              open = false;
            }
          };
          // First event names the thread, so a browser that started a new
          // conversation learns its id without a second request.
          send({ type: "conversation", id: conversation.id });
          try {
            for await (const event of runTurn(client, tools, history, request.signal)) {
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
            // An aborted request is the user leaving, not a failure: nothing to
            // report and nothing to log.
            if (!request.signal.aborted) {
              // The full error is for the server log only: an SDK error can
              // carry request detail the browser has no business seeing.
              console.error("Chat turn failed", cause);
              send({ type: "error", message: "Vastauksen haku epäonnistui" });
            }
          } finally {
            if (open) controller.close();
          }
        },

        /**
         * The browser dropped the connection. Marking the stream closed here
         * stops any event still in flight from being enqueued into a controller
         * that no longer has a reader -- which surfaced as an unhandled
         * "Invalid state: Reader released" rejection rather than as anything
         * the turn could act on.
         */
        cancel() {
          open = false;
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }),
  },
};
