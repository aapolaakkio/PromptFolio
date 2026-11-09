import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import {
  Ask,
  conversationMessages,
  deleteConversation,
  listConversations,
  Outcome,
  recordProposalOutcome,
  startTurn,
} from "../../server/chat/conversations.ts";
import { ConversationId } from "../../server/action-inputs.ts";
import { HttpError } from "../../server/errors.ts";
import { authed, readable } from "./guard.ts";

export const getConversations = createServerFn()
  .middleware([authed])
  .handler(({ context }) => readable(() => listConversations(context.userId)));

export const getConversationMessages = createServerFn()
  .middleware([authed])
  .validator(ConversationId)
  .handler(({ data, context }) => readable(() => conversationMessages(context.userId, data.id)));

export const removeConversation = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(ConversationId)
  .handler(({ data, context }) => readable(() => deleteConversation(context.userId, data.id)));

/** What the owner did with a proposal card; the action itself ran through its own form's server function. */
export const saveProposalOutcome = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(Outcome)
  .handler(({ data, context }) => readable(() => recordProposalOutcome(context.userId, data)));

/** Raw because the answer is an SSE stream; a refusal happens before the stream, as a JSON status code. */
export const askTurn = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(Ask)
  .handler(async ({ data, context }) => {
    const request = getRequest();
    try {
      const stream = await startTurn(context.userId, data, request.signal);
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    } catch (cause) {
      if (cause instanceof HttpError) {
        return Response.json({ error: cause.message }, { status: cause.status });
      }
      throw cause;
    }
  });
