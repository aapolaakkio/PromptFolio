import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";

import { apiDelete, apiGet } from "../lib/api";
import { askChat } from "./chat-stream";

const ConversationsSchema = z.object({
  conversations: z.array(z.object({ id: z.number(), title: z.string(), createdAt: z.string() })),
});

const MessagesSchema = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })),
});

type Turn = { readonly role: "user" | "assistant"; readonly content: string };

const TOOL_LABELS = new Map<string, string>([
  ["get_holdings", "omistukset"],
  ["get_allocation", "jakauma"],
  ["get_returns", "tuotto"],
  ["get_value_series", "arvon kehitys"],
  ["get_transactions", "tapahtumat"],
  ["get_instruments", "arvopaperit"],
]);

/**
 * Asks questions about the portfolio. The assistant reads the same figures the
 * rest of the app shows -- it has no way to write anything, and no arithmetic of
 * its own: every number it states came back from one of the tools named under
 * "Haettu:". That is what makes the answers checkable against the other screens.
 */
export const ChatPage = () => {
  const queryClient = useQueryClient();
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Turn[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const conversations = useQuery({
    queryKey: ["conversations"],
    queryFn: () => apiGet("/api/chat/conversations", ConversationsSchema),
  });

  const history = useQuery({
    queryKey: ["conversation", conversationId],
    enabled: conversationId !== null,
    queryFn: () => apiGet(`/api/chat/conversations/${conversationId}`, MessagesSchema),
  });

  const turns: Turn[] = [...(history.data?.messages ?? []), ...pending];

  const send = async () => {
    const message = draft.trim();
    if (message === "" || busy) return;
    setDraft("");
    setError(null);
    setTools([]);
    setBusy(true);
    // The question is shown immediately and the server's stored copy replaces it
    // once the turn is over; a slow answer must never make it look like the
    // question was lost.
    setPending([{ role: "user", content: message }]);

    try {
      const request = conversationId === null ? { message } : { message, conversationId };
      for await (const event of askChat(request)) {
        if (event.type === "conversation") setConversationId(event.id);
        if (event.type === "tool") setTools((previous) => [...previous, event.name]);
        if (event.type === "error") setError(event.message);
        if (event.type === "answer") {
          setPending((previous) => [...previous, { role: "assistant", content: event.text }]);
        }
      }
    } finally {
      setBusy(false);
      setPending([]);
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      void queryClient.invalidateQueries({ queryKey: ["conversation"] });
    }
  };

  const startNew = () => {
    setConversationId(null);
    setPending([]);
    setTools([]);
    setError(null);
  };

  const remove = async (id: number) => {
    await apiDelete(`/api/chat/conversations/${id}`);
    if (id === conversationId) startNew();
    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
  };

  return (
    <section className="grid gap-6 md:grid-cols-[14rem_1fr]">
      <aside className="grid content-start gap-2">
        <button type="button" onClick={startNew}>
          Uusi keskustelu
        </button>
        {(conversations.data?.conversations ?? []).map((conversation) => (
          <div key={conversation.id} className="flex items-center gap-2">
            <button
              type="button"
              className={conversation.id === conversationId ? "font-semibold" : "text-muted"}
              onClick={() => {
                setConversationId(conversation.id);
                setPending([]);
                setTools([]);
              }}
            >
              {conversation.title}
            </button>
            <button
              type="button"
              className="text-muted"
              aria-label={`Poista keskustelu ${conversation.title}`}
              onClick={() => void remove(conversation.id)}
            >
              ×
            </button>
          </div>
        ))}
      </aside>

      <div className="grid content-start gap-4">
        <div>
          <h1>Avustaja</h1>
          <p className="text-muted">
            Vastaa vain oman salkkusi luvuilla. Ei sijoitusneuvoja eikä ennusteita.
          </p>
        </div>

        <ol className="grid gap-3">
          {turns.map((turn, index) => (
            <li
              key={`${turn.role}-${index}`}
              className={
                turn.role === "user"
                  ? "justify-self-end rounded border border-line px-3 py-2"
                  : "whitespace-pre-wrap rounded bg-surface px-3 py-2"
              }
            >
              {turn.content}
            </li>
          ))}
        </ol>

        {busy && (
          <p className="text-muted">
            {tools.length === 0
              ? "Ajattelee…"
              : `Haettu: ${tools.map((name) => TOOL_LABELS.get(name) ?? name).join(", ")}`}
          </p>
        )}
        {error !== null && <p role="alert">{error}</p>}

        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <input
            className="flex-1"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Esim. mikä on salkun arvo tänään?"
            aria-label="Kysymys"
          />
          <button type="submit" disabled={busy || draft.trim() === ""}>
            Kysy
          </button>
        </form>
      </div>
    </section>
  );
};
