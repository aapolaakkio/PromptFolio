import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { Markdown } from "../markdown/Markdown.tsx";
import { getConversationMessages, getConversations, removeConversation } from "../server/chat.ts";
import { CHAT_MODELS, DEFAULT_CHAT_MODEL, type ChatModel } from "../../server/chat/models.ts";
import { askChat } from "./chat-stream.ts";

const isChatModel = (value: string): value is ChatModel =>
  CHAT_MODELS.some((model) => model.id === value);

type Turn = { readonly role: "user" | "assistant"; readonly content: string };

/** What each tool is called in the "Fetched:" line; a tool with no entry would show its raw name. */
const TOOL_LABELS = new Map<string, string>([
  ["get_holdings", "holdings"],
  ["get_allocation", "allocation"],
  ["get_returns", "returns"],
  ["get_value_series", "value over time"],
  ["get_transactions", "transactions"],
  ["get_instruments", "instruments"],
  ["get_cash", "cash"],
  ["get_fund_costs", "fund costs"],
  ["get_spending", "spending"],
  ["get_uncategorised_spending", "uncategorised"],
  ["get_cash_flow", "cash flow"],
  ["get_spending_trend", "spending trend"],
  ["get_transaction_class", "transaction class"],
  ["get_tax_year", "tax year"],
  ["get_drift", "drift from target"],
  ["get_deposit_plan", "deposit plan"],
  ["calculate", "calculator"],
  ["save_spending_rules", "saving rules"],
  ["update_spending_rule", "rule update"],
  ["remove_spending_rule", "rule removal"],
  ["get_spending_rules", "rules"],
  ["get_reconciliation", "reconciliation"],
  ["get_recurring_payments", "recurring payments"],
  ["get_net_worth_series", "net worth over time"],
]);

/** Asks about the portfolio. The assistant does no arithmetic: every figure came from a tool named under "Fetched:". It can only write a classification rule, shown on Spending as `ai`. */
export const ChatPage = () => {
  const queryClient = useQueryClient();
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Turn[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<ChatModel>(DEFAULT_CHAT_MODEL);
  // The answer so far, word by word, until the whole one arrives and replaces it.
  const [streaming, setStreaming] = useState("");

  const conversations = useQuery({
    queryKey: ["conversations"],
    queryFn: () => getConversations(),
  });

  const history = useQuery({
    queryKey: ["conversation", conversationId],
    // Not mid-turn: a fetch would return the stored question while `pending` still shows its copy, doubling it.
    enabled: conversationId !== null && !busy,
    queryFn: () => getConversationMessages({ data: { id: conversationId ?? 0 } }),
  });

  const turns: Turn[] = [...(history.data ?? []), ...pending];
  // The sidebar truncates titles to one line, so the whole title is shown here.
  const title =
    conversations.data?.find((conversation) => conversation.id === conversationId)?.title ?? null;

  // The transcript scrolls and follows the newest turn, so a long answer cannot push the question box off the page.
  const transcript = useRef<HTMLOListElement>(null);
  useEffect(() => {
    transcript.current?.scrollTo({ top: transcript.current.scrollHeight });
  }, [turns.length, busy, streaming]);

  const send = async () => {
    const message = draft.trim();
    if (message === "" || busy) return;
    setDraft("");
    setError(null);
    setTools([]);
    setBusy(true);
    // Shown immediately; the server's stored copy replaces it once the turn is over.
    setPending([{ role: "user", content: message }]);

    try {
      const request =
        conversationId === null ? { message, model } : { message, conversationId, model };
      for await (const event of askChat(request)) {
        if (event.type === "conversation") setConversationId(event.id);
        if (event.type === "tool") setTools((previous) => [...previous, event.name]);
        if (event.type === "error") setError(event.message);
        if (event.type === "delta") setStreaming((previous) => previous + event.text);
        if (event.type === "answer") {
          setStreaming("");
          setPending((previous) => [...previous, { role: "assistant", content: event.text }]);
        }
      }
    } finally {
      setBusy(false);
      setStreaming("");
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
    await removeConversation({ data: { id } });
    if (id === conversationId) startNew();
    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
  };

  return (
    <section className="grid gap-6 md:grid-cols-[14rem_1fr]">
      <aside className="grid content-start gap-3">
        <button type="button" onClick={startNew}>
          New conversation
        </button>
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
              ? "Answers only from your own portfolio figures. No investment advice or forecasts."
              : "Assistant — answers only from your own portfolio figures."}
          </p>
        </div>

        <ol ref={transcript} className="grid max-h-[55vh] content-start gap-3 overflow-y-auto pr-1">
          {turns.length === 0 && (
            <li className="text-muted text-sm">
              Ask, for example, where the money went last month, or ask it to categorise unknown
              payees.
            </li>
          )}
          {turns.map((turn, index) => (
            <li
              key={`${turn.role}-${index}`}
              className={
                turn.role === "user"
                  ? "justify-self-end max-w-[80%] whitespace-pre-wrap rounded border border-line px-3 py-2"
                  : "max-w-[90%] rounded bg-surface px-3 py-2"
              }
            >
              {turn.role === "user" ? turn.content : <Markdown text={turn.content} />}
            </li>
          ))}
          {streaming !== "" && (
            <li className="max-w-[90%] rounded bg-surface px-3 py-2">
              <Markdown text={streaming} />
            </li>
          )}
        </ol>

        {busy && streaming === "" && (
          <p className="text-muted">
            {tools.length === 0
              ? "Thinking…"
              : `Fetched: ${tools.map((name) => TOOL_LABELS.get(name) ?? name).join(", ")}`}
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
            placeholder="E.g. what is the portfolio worth today?"
            aria-label="Question"
          />
          <button type="submit" disabled={busy || draft.trim() === ""}>
            Ask
          </button>
        </form>
        <label className="mt-2 text-sm text-muted">
          Model
          <select
            value={model}
            disabled={busy}
            onChange={(event) => {
              if (isChatModel(event.target.value)) setModel(event.target.value);
            }}
          >
            {CHAT_MODELS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
};
