import { useQuery, useQueryClient } from "@tanstack/react-query";

import { getConversations, removeConversation } from "../server/chat.ts";
import { useAssistant } from "./assistant-context.ts";
import { ChatPanel } from "./ChatPanel.tsx";

const CHAT_PAGE = { page: "chat" } as const;

/** The full view: the conversation list beside the same conversation UI the docked panel shows, sharing its conversation. */
export const ChatPage = () => {
  const queryClient = useQueryClient();
  const { state, dispatch } = useAssistant();
  const { conversationId } = state;
  const choose = (id: number | null) => dispatch({ type: "conversation", id });

  const conversations = useQuery({
    queryKey: ["conversations"],
    queryFn: () => getConversations(),
  });

  // The sidebar truncates titles to one line, so the whole title is shown here.
  const title =
    conversations.data?.find((conversation) => conversation.id === conversationId)?.title ?? null;

  const remove = async (id: number) => {
    await removeConversation({ data: { id } });
    if (id === conversationId) choose(null);
    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
  };

  return (
    <section className="grid gap-6 md:grid-cols-[14rem_1fr]">
      <aside className="grid content-start gap-3">
        <ul className="grid max-h-[60vh] content-start gap-0.5 overflow-y-auto">
          {(conversations.data ?? []).map((conversation) => (
            <li key={conversation.id} className="group flex min-w-0 items-center">
              <button
                type="button"
                aria-current={conversation.id === conversationId ? "true" : undefined}
                className={
                  conversation.id === conversationId
                    ? "chat-row chat-row-current"
                    : "chat-row text-muted"
                }
                title={conversation.title}
                onClick={() => choose(conversation.id)}
              >
                {conversation.title}
              </button>
              <button
                type="button"
                className="chat-remove"
                aria-label={`Delete conversation ${conversation.title}`}
                onClick={() => void remove(conversation.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="grid content-start gap-4">
        <div>
          <h1>{title ?? "Assistant"}</h1>
          <p className="text-muted">
            {title === null
              ? "Answers from your own portfolio figures. Advice and forecasts are an AI's estimates."
              : "Assistant — answers only from your own portfolio figures."}
          </p>
        </div>
        <ChatPanel
          conversationId={conversationId}
          onConversation={choose}
          context={CHAT_PAGE}
          variant="page"
        />
      </div>
    </section>
  );
};
