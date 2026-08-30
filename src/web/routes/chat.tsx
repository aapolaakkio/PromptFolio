import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { Markdown } from "../markdown/Markdown.tsx";
import { getConversationMessages, getConversations, removeConversation } from "../server/chat.ts";
import { askChat } from "./chat-stream.ts";

type Turn = { readonly role: "user" | "assistant"; readonly content: string };

/**
 * What each tool is called in the "Haettu:" line.
 *
 * Complete on purpose: a name with no entry here was shown to the reader raw,
 * as `get_uncategorised_spending`, which is the internal name of a thing they
 * never asked about in those words.
 */
const TOOL_LABELS = new Map<string, string>([
  ["get_holdings", "omistukset"],
  ["get_allocation", "jakauma"],
  ["get_returns", "tuotto"],
  ["get_value_series", "arvon kehitys"],
  ["get_transactions", "tapahtumat"],
  ["get_instruments", "arvopaperit"],
  ["get_cash", "käteinen"],
  ["get_spending", "kulutus"],
  ["get_uncategorised_spending", "luokittelemattomat"],
  ["get_cash_flow", "rahavirta"],
  ["get_spending_trend", "kulutuksen kehitys"],
  ["get_transaction_class", "tapahtuman luokka"],
  ["get_tax_year", "verovuosi"],
  ["get_drift", "tavoite-ero"],
  ["get_deposit_plan", "uuden rahan jako"],
  ["calculate", "laskin"],
  ["save_spending_rules", "sääntöjen tallennus"],
  ["update_spending_rule", "säännön korjaus"],
  ["remove_spending_rule", "säännön poisto"],
  ["get_spending_rules", "säännöt"],
  ["get_reconciliation", "täsmäytys"],
  ["get_recurring_payments", "toistuvat maksut"],
  ["get_net_worth_series", "varallisuuden kehitys"],
]);

/**
 * Asks questions about the portfolio. The assistant reads the same figures the
 * rest of the app shows and does no arithmetic of its own: every number it
 * states came back from one of the tools named under "Haettu:". That is what
 * makes the answers checkable against the other screens. The only thing it can
 * write is a classification rule, which shows up on Kulutus marked `ai`.
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
    queryFn: () => getConversations(),
  });

  const history = useQuery({
    queryKey: ["conversation", conversationId],
    // Not while a turn is running. The server stores the question before the
    // model starts, and the id of a new conversation arrives mid-stream -- so a
    // fetch here would return that stored question while `pending` is still
    // showing its own optimistic copy, and the first message of every new
    // conversation appeared twice until the turn ended.
    enabled: conversationId !== null && !busy,
    queryFn: () => getConversationMessages({ data: { id: conversationId ?? 0 } }),
  });

  const turns: Turn[] = [...(history.data ?? []), ...pending];
  // The sidebar truncates to one line, so the only place the whole title exists
  // is here. A conversation is titled after its first question, which is
  // usually the one thing that says what the thread is about.
  const title =
    conversations.data?.find((conversation) => conversation.id === conversationId)?.title ?? null;

  // A long answer used to push the question box off the bottom of the page. The
  // transcript scrolls instead, and follows the newest turn -- otherwise a
  // reply arriving below the fold reads as nothing having happened.
  const transcript = useRef<HTMLOListElement>(null);
  useEffect(() => {
    transcript.current?.scrollTo({ top: transcript.current.scrollHeight });
  }, [turns.length, busy]);

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
    await removeConversation({ data: { id } });
    if (id === conversationId) startNew();
    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
  };

  return (
    <section className="grid gap-6 md:grid-cols-[14rem_1fr]">
      <aside className="grid content-start gap-3">
        <button type="button" onClick={startNew}>
          Uusi keskustelu
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
                aria-label={`Poista keskustelu ${conversation.title}`}
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
          <h1>{title ?? "Avustaja"}</h1>
          <p className="text-muted">
            {title === null
              ? "Vastaa vain oman salkkusi luvuilla. Ei sijoitusneuvoja eikä ennusteita."
              : "Avustaja — vastaa vain oman salkkusi luvuilla."}
          </p>
        </div>

        <ol ref={transcript} className="grid max-h-[55vh] content-start gap-3 overflow-y-auto pr-1">
          {turns.length === 0 && (
            <li className="text-muted text-sm">
              Kysy esimerkiksi mihin rahat kuluivat viime kuussa, tai pyydä luokittelemaan
              tuntemattomat maksunsaajat.
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
