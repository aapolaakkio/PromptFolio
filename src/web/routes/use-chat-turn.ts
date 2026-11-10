import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type Dispatch } from "react";

import { errorMessage } from "../lib/errors.ts";
import { getConversationMessages, saveProposalOutcome } from "../server/chat.ts";
import { DEFAULT_CHAT_MODEL, type ChatModel } from "../../server/chat/models.ts";
import type { PageContext } from "../../server/chat/page-context.ts";
import { readStored, StoredOutcome, type Proposal } from "../../server/chat/proposal-schema.ts";
import { useAssistant } from "./assistant-context.ts";
import type { PanelAction } from "./assistant-state.ts";
import { refreshAfterDecision } from "./chat-refresh.ts";
import { isConversationGone, settleCard, type LiveCard } from "./chat-rules.ts";
import { askChat, type ChatEvent } from "./chat-stream.ts";
import { createDecider, type CardOutcome } from "./proposal-actions.ts";

export type Turn = {
  readonly role: "user" | "assistant" | "proposal" | "note" | "chart";
  readonly content: string;
};

/** An error belongs to the conversation it happened in, so picking another one hides it. */
type ShownError = { readonly at: number | null; readonly message: string };

const storedOutcomes = (turns: readonly Turn[]): ReadonlyMap<string, CardOutcome> =>
  new Map(
    turns.flatMap((turn): [string, CardOutcome][] => {
      if (turn.role !== "note") return [];
      const parsed = readStored(StoredOutcome, turn.content);
      return parsed === null ? [] : [[parsed.proposalId, parsed]];
    }),
  );

const traceOf = (proposal: Proposal): Turn => ({
  role: "proposal",
  content: JSON.stringify({
    proposalId: proposal.proposalId,
    action: proposal.action,
    summary: proposal.summary,
    title: proposal.title,
    facts: proposal.facts,
  }),
});

const chartOf = (event: Extract<ChatEvent, { type: "chart" }>): Turn => ({
  role: "chart",
  content: JSON.stringify({ chartId: event.chartId, spec: event.spec, data: event.data }),
});

/** The stored turns; a conversation deleted elsewhere (or another owner's) starts fresh. */
const useHistory = (
  conversationId: number | null,
  busy: boolean,
  dispatch: Dispatch<PanelAction>,
) => {
  const history = useQuery({
    queryKey: ["conversation", conversationId],
    // Not mid-turn: a fetch would return the stored question while `pending` still shows its copy, doubling it.
    enabled: conversationId !== null && !busy,
    queryFn: () => getConversationMessages({ data: { id: conversationId ?? 0 } }),
  });
  const gone = isConversationGone(history.error);
  useEffect(() => {
    if (gone) dispatch({ type: "conversation", id: null });
  }, [gone, dispatch]);
  return gone ? [] : (history.data ?? []);
};

/** Cards streamed here; a failed outcome save shows whatever conversation is open. */
const useCards = () => {
  const queryClient = useQueryClient();
  const [live, setLive] = useState<ReadonlyMap<string, LiveCard>>(new Map());
  const [decided, setDecided] = useState<ReadonlyMap<string, CardOutcome>>(new Map());
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  // One per panel: it refuses a second decision on the same card, even from a double click.
  const decider = useRef(createDecider());

  const add = (card: LiveCard) =>
    setLive((previous) => new Map([...previous, [card.proposal.proposalId, card]]));

  const decide = async (proposalId: string, confirm: boolean) => {
    const card = live.get(proposalId);
    if (card === undefined) return;
    setSaveError(null);
    setSaving((previous) => new Set([...previous, proposalId]));
    const settled = await settleCard(card, confirm, {
      decide: decider.current,
      save: async (note) => {
        await saveProposalOutcome({ data: note });
      },
      refresh: (outcome) => refreshAfterDecision(queryClient, outcome),
    });
    setSaving((previous) => new Set([...previous].filter((id) => id !== proposalId)));
    if (settled === null) return;
    setDecided((previous) => new Map([...previous, [proposalId, settled.outcome]]));
    setLive((previous) => new Map([...previous].filter(([id]) => id !== proposalId)));
    setSaveError(settled.saveError);
  };

  return { live, decided, saving, saveError, add, decide };
};

type StreamDeps = {
  readonly context: PageContext | null;
  readonly model: ChatModel;
  readonly setError: (error: ShownError | null) => void;
  readonly addCard: (card: LiveCard) => void;
};

/** Applies one streamed event to the pending turns; `at` is the conversation the turn runs in. */
const useEvents = (setError: (error: ShownError) => void, addCard: (card: LiveCard) => void) => {
  const [pending, setPending] = useState<Turn[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  // The answer so far, word by word, until the whole one arrives and replaces it.
  const [streaming, setStreaming] = useState("");
  const append = (turn: Turn) => setPending((previous) => [...previous, turn]);
  const apply = (event: ChatEvent, at: number | null) => {
    if (event.type === "tool") setTools((previous) => [...previous, event.name]);
    if (event.type === "error") setError({ at, message: event.message });
    // The server names the conversation before anything else, so `at` is set by the time a card arrives.
    if (event.type === "proposal" && at !== null) {
      addCard({ proposal: event.proposal, conversationId: at });
      append(traceOf(event.proposal));
    }
    if (event.type === "chart") append(chartOf(event));
    if (event.type === "delta") setStreaming((previous) => previous + event.text);
    if (event.type === "answer") {
      setStreaming("");
      append({ role: "assistant", content: event.text });
    }
  };
  const start = (message: string) => {
    setTools([]);
    // Shown immediately; the server's stored copy replaces it once the turn is over.
    setPending([{ role: "user", content: message }]);
  };
  const end = () => {
    setStreaming("");
    setPending([]);
  };
  return { pending, tools, streaming, apply, start, end };
};

/** One turn's stream, from the question to the answer. */
const useStream = ({ context, model, setError, addCard }: StreamDeps) => {
  const { state, dispatch, setTurnRunning } = useAssistant();
  const queryClient = useQueryClient();
  const events = useEvents(setError, addCard);

  const run = async (message: string) => {
    setError(null);
    setTurnRunning(true);
    events.start(message);
    let at = state.conversationId;
    const base = at === null ? { message, model } : { message, conversationId: at, model };
    try {
      for await (const event of askChat(context === null ? base : { ...base, context })) {
        if (event.type !== "conversation") events.apply(event, at);
        else {
          at = event.id;
          dispatch({ type: "conversation", id: event.id });
        }
      }
    } catch (cause) {
      setError({ at, message: errorMessage(cause, "Could not fetch the answer") });
    } finally {
      setTurnRunning(false);
      events.end();
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      void queryClient.invalidateQueries({ queryKey: ["conversation"] });
    }
  };

  return { pending: events.pending, tools: events.tools, streaming: events.streaming, run };
};

/** One conversation's turns and cards. The busy flag is the shell's: one turn at a time across dock and page. */
export const useChatTurn = (context: PageContext | null) => {
  const { state, dispatch, turnRunning: busy } = useAssistant();
  const { conversationId } = state;
  const [error, setError] = useState<ShownError | null>(null);
  const [model, setModel] = useState<ChatModel>(DEFAULT_CHAT_MODEL);
  const cards = useCards();
  const stream = useStream({ context, model, setError, addCard: cards.add });
  const stored = useHistory(conversationId, busy, dispatch);

  const turns: Turn[] = [...stored, ...stream.pending];
  const outcomes = new Map([...storedOutcomes(turns), ...cards.decided]);

  /** Starts a turn unless one is running; true when the question was taken, so the composer can clear. */
  const ask = (text: string): boolean => {
    const message = text.trim();
    if (message === "" || busy) return false;
    void stream.run(message);
    return true;
  };

  return {
    conversationId,
    turns,
    streaming: stream.streaming,
    tools: stream.tools,
    busy,
    error:
      cards.saveError ?? (error !== null && error.at === conversationId ? error.message : null),
    model,
    setModel,
    ask,
    outcomes,
    live: cards.live,
    saving: cards.saving,
    decide: cards.decide,
  };
};
