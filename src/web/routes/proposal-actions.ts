import type { Proposal, ProposalAction } from "../../server/chat/proposal-schema.ts";
import { errorMessage } from "../lib/errors.ts";
import { createAccount, editAccount } from "../server/accounts.ts";
import { recordAccountBalance } from "../server/bank-imports.ts";
import { deleteCashEntry, saveCashEntry } from "../server/cash-entries.ts";
import { removeConversation } from "../server/chat.ts";
import { deleteForecastRate, saveForecastRate } from "../server/forecast.ts";
import { undoImport } from "../server/imports.ts";
import { createInstrument, editInstrument, setFundCharge } from "../server/instruments.ts";
import { deletePlanRow, savePlan, saveTargetAllocation } from "../server/rebalance.ts";
import { savePrice } from "../server/prices.ts";
import { adjustSnapshot, removeSnapshot, saveSnapshot } from "../server/snapshots.ts";
import {
  changeSpendingRule,
  deleteSpendingRule,
  saveSpendingRules,
} from "../server/spending-rules.ts";

type Input<A extends ProposalAction> = Extract<Proposal, { action: A }>["input"];

/** Per action, the form's own server function, so Confirm passes the same sign-in, ownership and validation. */
export type ProposalActions = {
  readonly [A in ProposalAction]: (args: { data: Input<A> }) => Promise<void>;
};

// Replies are dropped: the card needs only whether the save went through.
const formActions: ProposalActions = {
  record_price: async (args) => {
    await savePrice(args);
  },
  cash_entry: async (args) => {
    await saveCashEntry(args);
  },
  target_allocation: async (args) => {
    await saveTargetAllocation(args);
  },
  price_source: async (args) => {
    await editInstrument(args);
  },
  monthly_plan: async (args) => {
    await savePlan(args);
  },
  create_account: async (args) => {
    await createAccount(args);
  },
  edit_account: async (args) => {
    await editAccount(args);
  },
  account_balance: async (args) => {
    await recordAccountBalance(args);
  },
  create_instrument: async (args) => {
    await createInstrument(args);
  },
  fund_fee: async (args) => {
    await setFundCharge(args);
  },
  forecast_rate: async (args) => {
    await saveForecastRate(args);
  },
  snapshot: async (args) => {
    await saveSnapshot(args);
  },
  snapshot_adjust: async (args) => {
    await adjustSnapshot(args);
  },
  spending_rules: async (args) => {
    await saveSpendingRules(args);
  },
  spending_rule_category: async (args) => {
    await changeSpendingRule(args);
  },
  delete_cash_entry: async (args) => {
    await deleteCashEntry(args);
  },
  delete_plan_row: async (args) => {
    await deletePlanRow(args);
  },
  delete_spending_rule: async (args) => {
    await deleteSpendingRule(args);
  },
  remove_snapshot: async (args) => {
    await removeSnapshot(args);
  },
  undo_import: async (args) => {
    await undoImport(args);
  },
  remove_conversation: async (args) => {
    await removeConversation(args);
  },
  clear_fund_fee: async (args) => {
    await setFundCharge(args);
  },
  clear_forecast_rate: async (args) => {
    await deleteForecastRate(args);
  },
};

export type CardOutcome = {
  readonly outcome: "saved" | "failed" | "dismissed";
  readonly detail?: string;
};

const run = (proposal: Proposal, actions: ProposalActions): Promise<void> => {
  // SAFETY: `ProposalActions` keys each action to the function taking that action's input, and the union pairs `action` with its `input`.
  const save = actions[proposal.action] as (args: { data: Proposal["input"] }) => Promise<void>;
  return save({ data: proposal.input });
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

/**
 * One decision per proposal: a second click while the first save runs, or after it, does nothing (null).
 * Final even when the save failed, matching the one outcome note the server accepts.
 */
export const createDecider = (actions: ProposalActions = formActions) => {
  let started: ReadonlySet<string> = new Set();
  return async (proposal: Proposal, confirm: boolean): Promise<CardOutcome | null> => {
    if (started.has(proposal.proposalId)) return null;
    started = new Set([...started, proposal.proposalId]);
    return confirm ? await confirmProposal(proposal, actions) : { outcome: "dismissed" };
  };
};

/** Only a card streamed in this page session still holds its input; a stored one shows as expired. */
export const cardState = (
  live: Proposal | undefined,
  outcome: CardOutcome | undefined,
): "open" | "decided" | "expired" => {
  if (outcome !== undefined) return "decided";
  return live === undefined ? "expired" : "open";
};
