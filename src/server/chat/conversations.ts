import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/index.ts";
import { chatMessages, conversations } from "../db/schema.ts";
import { HttpError } from "../errors.ts";
import { CHAT_MODEL_IDS, DEFAULT_CHAT_MODEL } from "./models.ts";
import { runTurn, type ChatEvent, type ChatClient, createClient } from "./runner.ts";
import {
  ProposalOutcome,
  readStored,
  StoredOutcome,
  StoredProposal,
  type Proposal,
} from "./proposal-schema.ts";
import { buildProposalTools } from "./proposals.ts";
import { buildChatTools } from "./tools.ts";

export const Ask = z
  .object({
    conversationId: z.number().int().positive().optional(),
    message: z.string().trim().min(1, "The question cannot be empty").max(2000),
    model: z.enum(CHAT_MODEL_IDS).optional(),
  })
  .strict();

export const ConversationId = z.object({ id: z.number().int().positive() });

export const Outcome = z
  .object({
    conversationId: z.number().int().positive(),
    proposalId: z.string().min(1).max(64),
    outcome: ProposalOutcome,
    detail: z.string().trim().max(300).optional(),
  })
  .strict();

const resolveClient = (): ChatClient => createClient();

let clientOverride: ChatClient | null = null;
export const _setChatClient = (client: ChatClient | null): void => {
  clientOverride = client;
};

// Ownership first, and 404 not 403: confirming a stranger's conversation exists is a leak.
const ownedConversation = async (userId: string, id: number) => {
  const row = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
    .get();
  if (!row) throw new HttpError(404, "Conversation not found");
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

type Row = Awaited<ReturnType<typeof historyFor>>[number];

const APP_NOTE = "[App note, not written by the owner]";

const storedProposals = (rows: readonly Row[]) =>
  rows.flatMap((row) => {
    const proposal = row.role === "proposal" ? readStored(StoredProposal, row.content) : null;
    return proposal === null ? [] : [proposal];
  });

const outcomeText = (summary: string, outcome: z.infer<typeof StoredOutcome>): string => {
  switch (outcome.outcome) {
    case "saved":
      return `The owner confirmed "${summary}" and it was saved.`;
    case "failed":
      return `The owner confirmed "${summary}" but saving failed: ${outcome.detail ?? "no reason given"}. Nothing was saved.`;
    case "dismissed":
      return `The owner dismissed "${summary}". Nothing was saved.`;
  }
};

/** What the model reads: proposals and outcomes become app-written notes, built from stored summaries only. */
const modelHistory = (rows: readonly Row[]) => {
  const summaries = new Map(storedProposals(rows).map((p) => [p.proposalId, p.summary]));
  return rows.flatMap((row): { role: "user" | "assistant"; content: string }[] => {
    if (row.role === "user" || row.role === "assistant") {
      return [{ role: row.role, content: row.content }];
    }
    if (row.role === "proposal") {
      const proposal = readStored(StoredProposal, row.content);
      if (proposal === null) return [];
      const text = `The assistant proposed "${proposal.summary}". It is not saved unless the owner confirms it.`;
      return [{ role: "user", content: `${APP_NOTE} ${text}` }];
    }
    const outcome = readStored(StoredOutcome, row.content);
    const summary = outcome === null ? undefined : summaries.get(outcome.proposalId);
    if (outcome === null || summary === undefined) return [];
    return [{ role: "user", content: `${APP_NOTE} ${outcomeText(summary, outcome)}` }];
  });
};

const storedTrace = (proposal: Proposal): string =>
  JSON.stringify({
    proposalId: proposal.proposalId,
    action: proposal.action,
    summary: proposal.summary,
    title: proposal.title,
    facts: proposal.facts,
  });

/** Records what the owner did with a card, once; the next turn's model reads it as an app note. */
export const recordProposalOutcome = async (
  userId: string,
  input: z.infer<typeof Outcome>,
): Promise<void> => {
  const body = Outcome.parse(input);
  await ownedConversation(userId, body.conversationId);
  const rows = await historyFor(body.conversationId);
  if (!storedProposals(rows).some((p) => p.proposalId === body.proposalId)) {
    throw new HttpError(404, "Proposal not found");
  }
  const decided = rows.some(
    (row) =>
      row.role === "note" && readStored(StoredOutcome, row.content)?.proposalId === body.proposalId,
  );
  if (decided) throw new HttpError(409, "This proposal has already been decided");
  const note = StoredOutcome.parse({
    proposalId: body.proposalId,
    outcome: body.outcome,
    detail: body.outcome === "failed" ? body.detail : undefined,
  });
  await db
    .insert(chatMessages)
    .values({ conversationId: body.conversationId, role: "note", content: JSON.stringify(note) })
    .run();
};

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
  // Awaited: this is the ownership check, and an unawaited rejection would let messages through.
  await ownedConversation(userId, id);
  return await historyFor(id);
};

export const deleteConversation = async (userId: string, id: number): Promise<void> => {
  await ownedConversation(userId, id);
  await db.delete(conversations).where(eq(conversations.id, id)).run();
};

const sse = (event: ChatEvent): string => `data: ${JSON.stringify(event)}\n\n`;

/** Runs one turn, yielding SSE bytes. Anything that can refuse the turn throws before the stream exists, so it stays a status code. */
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
  if (conversation === undefined) throw new HttpError(500, "Creating the conversation failed");

  // Stored first, so a mid-way failure still shows what was asked.
  await db
    .insert(chatMessages)
    .values({ conversationId: conversation.id, role: "user", content: message })
    .run();

  const history = modelHistory(await historyFor(conversation.id));
  const tools = [...buildChatTools(db, userId), ...buildProposalTools(db, userId)];
  const used: string[] = [];

  let open = true;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      // A closed stream (browser navigated away) makes enqueue throw; nobody is left to send to.
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
          if (event.type === "proposal") {
            await db
              .insert(chatMessages)
              .values({
                conversationId: conversation.id,
                role: "proposal",
                content: storedTrace(event.proposal),
              })
              .run();
          }
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
          // Server log only: an SDK error can carry request detail the browser must not see.
          console.error("Chat turn failed", cause);
          send({ type: "error", message: "Fetching the answer failed" });
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
