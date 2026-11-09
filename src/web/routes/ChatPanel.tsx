import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type Ref } from "react";

import { errorMessage } from "../lib/errors.ts";
import { Markdown } from "../markdown/Markdown.tsx";
import { getConversationMessages, saveProposalOutcome } from "../server/chat.ts";
import { CHAT_MODELS, DEFAULT_CHAT_MODEL, type ChatModel } from "../../server/chat/models.ts";
import type { PageContext } from "../../server/chat/page-context.ts";
import {
  readStored,
  StoredOutcome,
  StoredProposal,
  type Proposal,
} from "../../server/chat/proposal-schema.ts";
import { StoredChartSchema } from "../../server/chat/chart-schema.ts";
import { ChatChart } from "../charts/ChatChart.tsx";
import { renderItems } from "./chat-order.ts";
import { refreshAfterDecision } from "./chat-refresh.ts";
import { askChat } from "./chat-stream.ts";
import { cardState, confirmLabel, createDecider, type CardOutcome } from "./proposal-actions.ts";
import { ProposalCard } from "./ProposalCard.tsx";
import { TOOL_LABELS } from "./tool-labels.ts";

const isChatModel = (value: string): value is ChatModel =>
  CHAT_MODELS.some((model) => model.id === value);

type Turn = {
  readonly role: "user" | "assistant" | "proposal" | "note" | "chart";
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

type ChatPanelProps = {
  readonly conversationId: number | null;
  readonly onConversation: (id: number | null) => void;
  /** Where the owner asks from; the server resolves its ids and writes the line the model sees. */
  readonly context: PageContext | null;
  /** "dock" fills the side panel's height; "page" keeps the full Chat page's fixed transcript height. */
  readonly variant: "page" | "dock";
  readonly composerRef?: Ref<HTMLInputElement>;
};

/** The one conversation UI, on the Chat page and in the docked panel. The assistant does no arithmetic: every figure came from a tool named under "Fetched:". It writes nothing itself: every change is a card the owner confirms. */
export const ChatPanel = ({
  conversationId,
  onConversation,
  context,
  variant,
  composerRef,
}: ChatPanelProps) => {
  const queryClient = useQueryClient();
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
  // One per panel: it refuses a second decision on the same card, even from a double click.
  const decider = useRef(createDecider());

  const history = useQuery({
    queryKey: ["conversation", conversationId],
    // Not mid-turn: a fetch would return the stored question while `pending` still shows its copy, doubling it.
    enabled: conversationId !== null && !busy,
    queryFn: () => getConversationMessages({ data: { id: conversationId ?? 0 } }),
  });

  const turns: Turn[] = [...(history.data ?? []), ...pending];
  const outcomes = new Map([...storedOutcomes(turns), ...decided]);

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
      const base =
        conversationId === null ? { message, model } : { message, conversationId, model };
      const request = context === null ? base : { ...base, context };
      for await (const event of askChat(request)) {
        if (event.type === "conversation") onConversation(event.id);
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
            danger: proposal.danger,
          };
          setPending((previous) => [
            ...previous,
            { role: "proposal", content: JSON.stringify(trace) },
          ]);
        }
        if (event.type === "chart") {
          const chart = { chartId: event.chartId, spec: event.spec, data: event.data };
          setPending((previous) => [
            ...previous,
            { role: "chart", content: JSON.stringify(chart) },
          ]);
        }
        if (event.type === "delta") setStreaming((previous) => previous + event.text);
        if (event.type === "answer") {
          setStreaming("");
          setPending((previous) => [...previous, { role: "assistant", content: event.text }]);
        }
      }
    } catch (cause) {
      setError(errorMessage(cause, "Could not fetch the answer"));
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
    refreshAfterDecision(queryClient, outcome);
  };

  const startNew = () => {
    onConversation(null);
    setPending([]);
    setTools([]);
    setError(null);
  };

  return (
    <div
      className={
        variant === "dock" ? "flex min-h-0 flex-1 flex-col gap-3" : "grid content-start gap-4"
      }
    >
      <ol
        ref={transcript}
        className={
          variant === "dock"
            ? "grid min-h-0 flex-1 content-start gap-3 overflow-y-auto pr-1"
            : "grid max-h-[55vh] content-start gap-3 overflow-y-auto pr-1"
        }
      >
        {turns.length === 0 && (
          <li className="text-muted text-sm">
            Ask, for example, where the money went last month, or ask it to categorise unknown
            payees.
          </li>
        )}
        {renderItems(
          streaming === "" ? turns : [...turns, { role: "assistant", content: streaming }],
        ).map((item) => {
          if (item.kind === "user") {
            return (
              <li
                key={item.key}
                className="justify-self-end max-w-[80%] whitespace-pre-wrap rounded border border-line px-3 py-2"
              >
                {item.content}
              </li>
            );
          }
          if (item.kind === "text") {
            return (
              <li key={item.key} className="max-w-[90%] rounded bg-surface px-3 py-2">
                <Markdown text={item.content} />
              </li>
            );
          }
          const { turn } = item;
          if (turn.role === "chart") {
            const chart = readStored(StoredChartSchema, turn.content);
            if (chart === null) return null;
            return (
              <li key={`chart-${chart.chartId}`}>
                {"expired" in chart ? (
                  <div className="card max-w-[90%] grid gap-1 text-sm">
                    <span className="font-semibold">{chart.spec.title}</span>
                    <span className="text-muted">Chart expired — ask again.</span>
                  </div>
                ) : (
                  <ChatChart chart={chart} />
                )}
              </li>
            );
          }
          if (turn.role !== "proposal") return null;
          const card = readStored(StoredProposal, turn.content);
          if (card === null) return null;
          const { proposalId, title, facts, action, danger } = card;
          const streamed = live.get(proposalId);
          return (
            <li key={`proposal-${proposalId}`}>
              <ProposalCard
                title={title}
                facts={facts}
                note={streamed?.action === "cash_entry" ? streamed.input.note : undefined}
                danger={danger === true}
                permanent={action !== "undo_import"}
                confirmLabel={confirmLabel(action)}
                state={cardState(streamed, outcomes.get(proposalId))}
                outcome={outcomes.get(proposalId)}
                saving={saving.has(proposalId)}
                onConfirm={() => void decide(proposalId, true)}
                onDismiss={() => void decide(proposalId, false)}
              />
            </li>
          );
        })}
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
          ref={composerRef}
          className="min-w-0 flex-1"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="E.g. what is the portfolio worth today?"
          aria-label="Question"
        />
        <button type="submit" disabled={busy || draft.trim() === ""}>
          Ask
        </button>
      </form>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <label className="mb-0 text-sm text-muted">
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
        <button type="button" className="quiet-button" disabled={busy} onClick={startNew}>
          New conversation
        </button>
      </div>
    </div>
  );
};
