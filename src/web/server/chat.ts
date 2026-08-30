import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import {
  Ask,
  ConversationId,
  conversationMessages,
  deleteConversation,
  listConversations,
  startTurn,
} from "../../server/chat/conversations.ts";
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

/**
 * Raw because the answer arrives token by token: the turn is an SSE stream, not
 * a value. A refusal still happens before the stream exists, so it stays a
 * status code the browser can read as JSON.
 */
export const askTurn = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(Ask)
  .handler(({ data, context }) => {
    const request = getRequest();
    try {
      const stream = startTurn(context.userId, data, request.signal);
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
