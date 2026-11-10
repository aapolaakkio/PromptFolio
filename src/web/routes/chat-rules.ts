import { errorMessage } from "../lib/errors.ts";
import { CONVERSATION_NOT_FOUND } from "../../server/chat/conversation-errors.ts";
import type { Proposal } from "../../server/chat/proposal-schema.ts";
import type { CardOutcome } from "./proposal-actions.ts";

/** A card streamed in this panel, with the conversation it was streamed in. */
export type LiveCard = { readonly proposal: Proposal; readonly conversationId: number };

type SettleDeps = {
  readonly decide: (proposal: Proposal, confirm: boolean) => Promise<CardOutcome | null>;
  readonly save: (
    note: { readonly conversationId: number; readonly proposalId: string } & CardOutcome,
  ) => Promise<void>;
  readonly refresh: (outcome: CardOutcome) => void;
};

/** Decides a card once and records it in the card's own conversation, never the one open now. */
export const settleCard = async (
  card: LiveCard,
  confirm: boolean,
  { decide, save, refresh }: SettleDeps,
): Promise<{ readonly outcome: CardOutcome; readonly saveError: string | null } | null> => {
  const outcome = await decide(card.proposal, confirm);
  if (outcome === null) return null;
  const { conversationId } = card;
  const { proposalId } = card.proposal;
  const saveError = await save({ conversationId, proposalId, ...outcome }).then(
    () => null,
    (cause: unknown) => errorMessage(cause, "Could not tell the assistant what happened"),
  );
  refresh(outcome);
  return { outcome, saveError };
};

/** The stored conversation was deleted elsewhere, or belongs to someone else: start fresh. */
export const isConversationGone = (error: Error | null): boolean =>
  error?.message === CONVERSATION_NOT_FOUND;
