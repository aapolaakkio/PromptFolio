import { describe, expect, test, vi } from "vitest";

import { EUR } from "../../core/money.ts";
import type { Proposal } from "../../server/chat/proposal-schema.ts";
import { refreshAfterDecision } from "./chat-refresh.ts";
import { createDecider, type ProposalActions } from "./proposal-actions.ts";

const deposit: Proposal = {
  proposalId: "c1",
  summary: "s",
  title: "t",
  facts: [],
  action: "cash_entry",
  input: { accountId: 1, type: "DEPOSIT", tradeDate: "2026-11-02", amount: "100", currency: EUR },
};

// Every action saves the same way; only `cash_entry` runs here.
const saving = (save: () => Promise<void>): ProposalActions => ({
  record_price: save,
  cash_entry: save,
  target_allocation: save,
  price_source: save,
  monthly_plan: save,
  create_account: save,
  edit_account: save,
  account_balance: save,
  create_instrument: save,
  fund_fee: save,
  forecast_rate: save,
  snapshot: save,
  snapshot_adjust: save,
  spending_rules: save,
  spending_rule_category: save,
  delete_cash_entry: save,
  delete_plan_row: save,
  delete_spending_rule: save,
  remove_snapshot: save,
  undo_import: save,
  remove_conversation: save,
  clear_fund_fee: save,
  clear_forecast_rate: save,
});

const client = () => ({ invalidateQueries: vi.fn(() => Promise.resolve()) });

describe("refreshAfterDecision", () => {
  test("a saved card refreshes every query once, so the page behind the panel shows it", async () => {
    const queries = client();
    const decide = createDecider(saving(() => Promise.resolve()));

    refreshAfterDecision(queries, await decide(deposit, true));
    refreshAfterDecision(queries, await decide(deposit, true));

    expect(queries.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(queries.invalidateQueries).toHaveBeenCalledWith();
  });

  test("a dismissed or failed card refreshes only the conversation", () => {
    const queries = client();
    refreshAfterDecision(queries, { outcome: "dismissed" });
    refreshAfterDecision(queries, { outcome: "failed", detail: "offline" });
    expect(queries.invalidateQueries.mock.calls).toEqual([
      [{ queryKey: ["conversation"] }],
      [{ queryKey: ["conversation"] }],
    ]);
  });
});
