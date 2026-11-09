import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { errorMessage } from "../lib/errors.ts";
import { Markdown } from "../markdown/Markdown.tsx";
import {
  getConversationMessages,
  getConversations,
  removeConversation,
  saveProposalOutcome,
} from "../server/chat.ts";
import { CHAT_MODELS, DEFAULT_CHAT_MODEL, type ChatModel } from "../../server/chat/models.ts";
import {
  readStored,
  StoredOutcome,
  StoredProposal,
  type Proposal,
} from "../../server/chat/proposal-schema.ts";
import { askChat } from "./chat-stream.ts";
import { cardState, createDecider, type CardOutcome } from "./proposal-actions.ts";
import { ProposalCard } from "./ProposalCard.tsx";

const isChatModel = (value: string): value is ChatModel =>
  CHAT_MODELS.some((model) => model.id === value);

type Turn = {
  readonly role: "user" | "assistant" | "proposal" | "note";
  readonly content: string;
};

const storedOutcomes = (turns: readonly Turn[]): ReadonlyMap<string, CardOutcome> =>
  new Map(
    turns.flatMap((turn): [string, CardOutcome][] => {
      if (turn.role !== "note") return [];
      const parsed = readStored(StoredOutcome, turn.content);
      return parsed === null ? [] : [[parsed.proposalId, parsed]];
    }),
  );

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
  ["propose_record_price", "price proposal"],
  ["propose_cash_entry", "cash entry proposal"],
  ["propose_target_allocation", "target proposal"],
  ["propose_price_source", "price source proposal"],
  ["propose_monthly_plan", "monthly plan proposal"],
  ["get_monthly_plan", "monthly plan"],
]);

/** Asks about the portfolio. The assistant does no arithmetic: every figure came from a tool named under "Fetched:". It writes only classification rules, shown on Spending as `ai`; any other change is a card the owner confirms. */
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
  // Proposals streamed in this page session, with their input; a reload empties this, so stored cards show as expired.
  const [live, setLive] = useState<ReadonlyMap<string, Proposal>>(new Map());
  const [decided, setDecided] = useState<ReadonlyMap<string, CardOutcome>>(new Map());
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  // One per page: it refuses a second decision on the same card, even from a double click.
  const decider = useRef(createDecider());

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
  const outcomes = new Map([...storedOutcomes(turns), ...decided]);
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
        if (event.type === "proposal") {
          const { proposal } = event;
          setLive((previous) => new Map([...previous, [proposal.proposalId, proposal]]));
          const trace = {
            proposalId: proposal.proposalId,
            action: proposal.action,
            summary: proposal.summary,
            title: proposal.title,
            facts: proposal.facts,
          };
          setPending((previous) => [
            ...previous,
            { role: "proposal", content: JSON.stringify(trace) },
          ]);
        }
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

  /** Runs the action through its form's server function, then tells the conversation what happened. */
  const decide = async (proposalId: string, confirm: boolean) => {
    const proposal = live.get(proposalId);
    if (proposal === undefined || conversationId === null) return;
    setSaving((previous) => new Set([...previous, proposalId]));
    const outcome = await decider.current(proposal, confirm);
    setSaving((previous) => new Set([...previous].filter((id) => id !== proposalId)));
    if (outcome === null) return;
    setDecided((previous) => new Map([...previous, [proposalId, outcome]]));
    setLive((previous) => new Map([...previous].filter(([id]) => id !== proposalId)));
    try {
      await saveProposalOutcome({ data: { conversationId, proposalId, ...outcome } });
    } catch (cause) {
      setError(errorMessage(cause, "Could not tell the assistant what happened"));
    }
    if (outcome.outcome === "saved") void queryClient.invalidateQueries();
    else void queryClient.invalidateQueries({ queryKey: ["conversation"] });
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
          {turns.map((turn, index) => {
            if (turn.role === "note") return null;
            if (turn.role === "proposal") {
              const card = readStored(StoredProposal, turn.content);
              if (card === null) return null;
              const { proposalId, title, facts } = card;
              const streamed = live.get(proposalId);
              return (
                <li key={`proposal-${proposalId}`}>
                  <ProposalCard
                    title={title}
                    facts={facts}
                    note={streamed?.action === "cash_entry" ? streamed.input.note : undefined}
                    state={cardState(streamed, outcomes.get(proposalId))}
                    outcome={outcomes.get(proposalId)}
                    saving={saving.has(proposalId)}
                    onConfirm={() => void decide(proposalId, true)}
                    onDismiss={() => void decide(proposalId, false)}
                  />
                </li>
              );
            }
            return (
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
            );
          })}
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
