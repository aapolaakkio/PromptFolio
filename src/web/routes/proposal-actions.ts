import type { Proposal } from "../../server/chat/proposal-schema.ts";
import { errorMessage } from "../lib/errors.ts";
import { saveCashEntry } from "../server/cash-entries.ts";
import { editInstrument } from "../server/instruments.ts";
import { savePrice } from "../server/prices.ts";
import { saveTargetAllocation } from "../server/rebalance.ts";

type Input<A extends Proposal["action"]> = Extract<Proposal, { action: A }>["input"];

/** The forms' own server functions, so Confirm passes the same sign-in, ownership and validation. */
export type ProposalActions = {
  readonly savePrice: (args: { data: Input<"record_price"> }) => Promise<void>;
  readonly saveCashEntry: (args: { data: Input<"cash_entry"> }) => Promise<void>;
  readonly saveTargetAllocation: (args: { data: Input<"target_allocation"> }) => Promise<void>;
  readonly editInstrument: (args: { data: Input<"price_source"> }) => Promise<void>;
};

// Replies are dropped: the card needs only whether the save went through.
const formActions: ProposalActions = {
  savePrice: async (args) => void (await savePrice(args)),
  saveCashEntry: async (args) => void (await saveCashEntry(args)),
  saveTargetAllocation: async (args) => void (await saveTargetAllocation(args)),
  editInstrument: async (args) => void (await editInstrument(args)),
};

export type CardOutcome = {
  readonly outcome: "saved" | "failed" | "dismissed";
  readonly detail?: string;
};

const run = (proposal: Proposal, actions: ProposalActions): Promise<void> => {
  switch (proposal.action) {
    case "record_price":
      return actions.savePrice({ data: proposal.input });
    case "cash_entry":
      return actions.saveCashEntry({ data: proposal.input });
    case "target_allocation":
      return actions.saveTargetAllocation({ data: proposal.input });
    case "price_source":
      return actions.editInstrument({ data: proposal.input });
  }
};

export const confirmProposal = async (
  proposal: Proposal,
  actions: ProposalActions = formActions,
): Promise<CardOutcome> => {
  try {
    await run(proposal, actions);
    return { outcome: "saved" };
  } catch (cause) {
    return { outcome: "failed", detail: errorMessage(cause, "Saving failed").slice(0, 300) };
  }
};

/** Only a card streamed in this page session still holds its input; a stored one shows as expired. */
export const cardState = (
  live: Proposal | undefined,
  outcome: CardOutcome | undefined,
): "open" | "decided" | "expired" => {
  if (outcome !== undefined) return "decided";
  return live === undefined ? "expired" : "open";
};
