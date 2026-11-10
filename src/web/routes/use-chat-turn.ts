import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type Dispatch } from "react";

import { errorMessage } from "../lib/errors.ts";
import { getConversationMessages, saveProposalOutcome } from "../server/chat.ts";
import { CONVERSATION_NOT_FOUND } from "../../server/chat/conversation-errors.ts";
import { DEFAULT_CHAT_MODEL, type ChatModel } from "../../server/chat/models.ts";
import type { PageContext } from "../../server/chat/page-context.ts";
import { readStored, StoredOutcome, type Proposal } from "../../server/chat/proposal-schema.ts";
import { useAssistant } from "./assistant-context.ts";
import type { PanelAction } from "./assistant-state.ts";
import { refreshAfterDecision } from "./chat-refresh.ts";
import { askChat, type ChatEvent } from "./chat-stream.ts";
import { createDecider, type CardOutcome } from "./proposal-actions.ts";

export type Turn = {
  readonly role: "user" | "assistant" | "proposal" | "note" | "chart";
  readonly content: string;
};

/** A card streamed in this panel, with the conversation it was streamed in: its outcome is recorded there, whatever is open now. */
export type LiveCard = { readonly proposal: Proposal; readonly conversationId: number | null };

/** An error belongs to the conversation it happened in, so picking another one hides it. */
type ShownError = { readonly at: number | null; readonly message: string };

const NO_CONVERSATION =
  "This card was not tied to a conversation, so it cannot be confirmed. Ask again.";

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

/** The stored turns; a conversation deleted elsewhere (or another owner's, after a sign-in on this browser) starts fresh. */
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
  const gone = history.error?.message === CONVERSATION_NOT_FOUND;
  useEffect(() => {
    if (gone) dispatch({ type: "conversation", id: null });
  }, [gone, dispatch]);
  return gone ? [] : (history.data ?? []);
};

/** Cards streamed here and their outcomes; Confirm records against the card's own conversation. */
const useCards = (setError: (error: ShownError) => void) => {
  const queryClient = useQueryClient();
  const [live, setLive] = useState<ReadonlyMap<string, LiveCard>>(new Map());
  const [decided, setDecided] = useState<ReadonlyMap<string, CardOutcome>>(new Map());
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  // One per panel: it refuses a second decision on the same card, even from a double click.
  const decider = useRef(createDecider());

  const add = (card: LiveCard) =>
    setLive((previous) => new Map([...previous, [card.proposal.proposalId, card]]));

  const decide = async (proposalId: string, confirm: boolean) => {
    const card = live.get(proposalId);
    if (card === undefined) return;
    const at = card.conversationId;
    if (at === null) return setError({ at, message: NO_CONVERSATION });
    setSaving((previous) => new Set([...previous, proposalId]));
    const outcome = await decider.current(card.proposal, confirm);
    setSaving((previous) => new Set([...previous].filter((id) => id !== proposalId)));
    if (outcome === null) return;
    setDecided((previous) => new Map([...previous, [proposalId, outcome]]));
    setLive((previous) => new Map([...previous].filter(([id]) => id !== proposalId)));
    try {
      await saveProposalOutcome({ data: { conversationId: at, proposalId, ...outcome } });
    } catch (cause) {
      setError({ at, message: errorMessage(cause, "Could not tell the assistant what happened") });
    }
    refreshAfterDecision(queryClient, outcome);
  };

  return { live, decided, saving, add, decide };
};

type StreamDeps = {
  readonly context: PageContext | null;
  readonly model: ChatModel;
  readonly setError: (error: ShownError | null) => void;
  readonly addCard: (card: LiveCard) => void;
};

/** One turn's stream: the question shown at once, then tools, cards, charts and the answer as they arrive. */
const useStream = ({ context, model, setError, addCard }: StreamDeps) => {
  const { state, dispatch, setTurnRunning } = useAssistant();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Turn[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  // The answer so far, word by word, until the whole one arrives and replaces it.
  const [streaming, setStreaming] = useState("");

  const apply = (event: ChatEvent, at: number | null) => {
    if (event.type === "tool") setTools((previous) => [...previous, event.name]);
    if (event.type === "error") setError({ at, message: event.message });
    if (event.type === "proposal") {
      addCard({ proposal: event.proposal, conversationId: at });
      setPending((previous) => [...previous, traceOf(event.proposal)]);
    }
    if (event.type === "chart") setPending((previous) => [...previous, chartOf(event)]);
    if (event.type === "delta") setStreaming((previous) => previous + event.text);
    if (event.type === "answer") {
      setStreaming("");
      setPending((previous) => [...previous, { role: "assistant", content: event.text }]);
    }
  };

  const run = async (message: string) => {
    setError(null);
    setTools([]);
    setTurnRunning(true);
    // Shown immediately; the server's stored copy replaces it once the turn is over.
    setPending([{ role: "user", content: message }]);
    let at = state.conversationId;
    const base = at === null ? { message, model } : { message, conversationId: at, model };
    try {
      for await (const event of askChat(context === null ? base : { ...base, context })) {
        if (event.type !== "conversation") apply(event, at);
        else {
          at = event.id;
          dispatch({ type: "conversation", id: event.id });
        }
      }
    } catch (cause) {
      setError({ at, message: errorMessage(cause, "Could not fetch the answer") });
    } finally {
      setTurnRunning(false);
      setStreaming("");
      setPending([]);
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      void queryClient.invalidateQueries({ queryKey: ["conversation"] });
    }
  };

  return { pending, tools, streaming, run };
};

/** One conversation's turns, the answer streaming into it, and its cards. The busy flag is the shell's, so the dock and the Chat page never run two turns at once. */
export const useChatTurn = (context: PageContext | null) => {
  const { state, dispatch, turnRunning: busy } = useAssistant();
  const { conversationId } = state;
  const [error, setError] = useState<ShownError | null>(null);
  const [model, setModel] = useState<ChatModel>(DEFAULT_CHAT_MODEL);
  const cards = useCards(setError);
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
    turns,
    streaming: stream.streaming,
    tools: stream.tools,
    busy,
    error: error !== null && error.at === conversationId ? error.message : null,
    model,
    setModel,
    ask,
    outcomes,
    live: cards.live,
    saving: cards.saving,
    decide: cards.decide,
  };
};
