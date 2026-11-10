import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { errorMessage } from "../lib/errors.ts";

import { getConversations, removeConversation } from "../server/chat.ts";
import { useAssistant } from "./assistant-context.ts";
import { ChatPanel } from "./ChatPanel.tsx";

const CHAT_PAGE = { page: "chat" } as const;

type Conversation = { readonly id: number; readonly title: string };

/** Switching or deleting waits for the running turn: its answer belongs to the conversation it was asked in. */
const ConversationList = ({
  conversations,
  current,
  busy,
  onChoose,
  onRemove,
}: {
  readonly conversations: readonly Conversation[];
  readonly current: number | null;
  readonly busy: boolean;
  readonly onChoose: (id: number | null) => void;
  readonly onRemove: (id: number) => void;
}) => (
  <aside className="grid content-start gap-3">
    <button type="button" disabled={busy} onClick={() => onChoose(null)}>
      New conversation
    </button>
    <ul className="grid max-h-[60vh] content-start gap-0.5 overflow-y-auto">
      {conversations.map((conversation) => (
        <li key={conversation.id} className="group flex min-w-0 items-center">
          <button
            type="button"
            disabled={busy}
            aria-current={conversation.id === current ? "true" : undefined}
            className={
              conversation.id === current ? "chat-row chat-row-current" : "chat-row text-muted"
            }
            title={conversation.title}
            onClick={() => onChoose(conversation.id)}
          >
            {conversation.title}
          </button>
          <button
            type="button"
            className="chat-remove"
            disabled={busy}
            aria-label={`Delete conversation ${conversation.title}`}
            onClick={() => onRemove(conversation.id)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  </aside>
);

/** The full view: the conversation list beside the same conversation UI the docked panel shows, sharing its conversation. */
export const ChatPage = () => {
  const queryClient = useQueryClient();
  const { state, dispatch, turnRunning } = useAssistant();
  const { conversationId } = state;
  const choose = (id: number | null) => dispatch({ type: "conversation", id });

  const conversations = useQuery({
    queryKey: ["conversations"],
    queryFn: () => getConversations(),
  });

  // The sidebar truncates titles to one line, so the whole title is shown here.
  const title =
    conversations.data?.find((conversation) => conversation.id === conversationId)?.title ?? null;

  const [removeError, setRemoveError] = useState<string | null>(null);
  const remove = async (id: number) => {
    setRemoveError(null);
    try {
      await removeConversation({ data: { id } });
    } catch (cause) {
      setRemoveError(errorMessage(cause, "Could not delete the conversation"));
      return;
    }
    if (id === conversationId) choose(null);
    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
  };

  return (
    <section className="grid gap-6 md:grid-cols-[14rem_1fr]">
      <ConversationList
        conversations={conversations.data ?? []}
        current={conversationId}
        busy={turnRunning}
        onChoose={choose}
        onRemove={(id) => void remove(id)}
      />
      <div className="grid content-start gap-4">
        <div>
          <h1>{title ?? "Assistant"}</h1>
          <p className="text-muted">
            {title === null
              ? "Answers from your own portfolio figures. Advice and forecasts are an AI's estimates."
              : "Assistant — answers only from your own portfolio figures."}
          </p>
        </div>
        {removeError !== null && <p role="alert">{removeError}</p>}
        <ChatPanel context={CHAT_PAGE} variant="page" />
      </div>
    </section>
  );
};
