import { describe, expect, test, vi } from "vitest";

import { EUR } from "../../core/money.ts";
import type { Proposal, ProposalAction } from "../../server/chat/proposal-schema.ts";
import {
  cardState,
  confirmLabel,
  confirmProposal,
  createDecider,
  type ProposalActions,
} from "./proposal-actions.ts";

const ACTION_NAMES: readonly ProposalAction[] = [
  "record_price",
  "cash_entry",
  "target_allocation",
  "price_source",
  "monthly_plan",
  "create_account",
  "edit_account",
  "account_balance",
  "create_instrument",
  "fund_fee",
  "forecast_rate",
  "snapshot",
  "snapshot_adjust",
  "spending_rules",
  "spending_rule_category",
  "delete_cash_entry",
  "delete_plan_row",
  "delete_spending_rule",
  "remove_snapshot",
  "undo_import",
  "remove_conversation",
  "clear_fund_fee",
  "clear_forecast_rate",
];

const actions = (): ProposalActions => ({
  record_price: vi.fn(() => Promise.resolve()),
  cash_entry: vi.fn(() => Promise.resolve()),
  target_allocation: vi.fn(() => Promise.resolve()),
  price_source: vi.fn(() => Promise.resolve()),
  monthly_plan: vi.fn(() => Promise.resolve()),
  create_account: vi.fn(() => Promise.resolve()),
  edit_account: vi.fn(() => Promise.resolve()),
  account_balance: vi.fn(() => Promise.resolve()),
  create_instrument: vi.fn(() => Promise.resolve()),
  fund_fee: vi.fn(() => Promise.resolve()),
  forecast_rate: vi.fn(() => Promise.resolve()),
  snapshot: vi.fn(() => Promise.resolve()),
  snapshot_adjust: vi.fn(() => Promise.resolve()),
  spending_rules: vi.fn(() => Promise.resolve()),
  spending_rule_category: vi.fn(() => Promise.resolve()),
  delete_cash_entry: vi.fn(() => Promise.resolve()),
  delete_plan_row: vi.fn(() => Promise.resolve()),
  delete_spending_rule: vi.fn(() => Promise.resolve()),
  remove_snapshot: vi.fn(() => Promise.resolve()),
  undo_import: vi.fn(() => Promise.resolve()),
  remove_conversation: vi.fn(() => Promise.resolve()),
  clear_fund_fee: vi.fn(() => Promise.resolve()),
  clear_forecast_rate: vi.fn(() => Promise.resolve()),
});

const card = { summary: "s", title: "t", facts: [] };

/** One validated input per action, as a proposal tool would have produced it. */
const PROPOSALS: readonly Proposal[] = [
  {
    ...card,
    proposalId: "a1",
    action: "record_price",
    input: { instrumentId: 1, date: "2026-11-02", price: "10" },
  },
  {
    ...card,
    proposalId: "a2",
    action: "cash_entry",
    input: {
      accountId: 3,
      type: "WITHDRAWAL",
      tradeDate: "2026-11-03",
      amount: "250",
      currency: EUR,
    },
  },
  {
    ...card,
    proposalId: "a3",
    action: "target_allocation",
    input: { dimension: "kind", targets: [{ key: "fund", weightPercent: "100" }] },
  },
  {
    ...card,
    proposalId: "a4",
    action: "price_source",
    input: { id: 4, currency: EUR, priceSource: "manual", sourceKey: "" },
  },
  {
    ...card,
    proposalId: "a5",
    action: "monthly_plan",
    input: {
      rows: [{ instrumentId: 4, amountEur: "100" }],
      removeInstrumentIds: [],
      fingerprint: "",
    },
  },
  {
    ...card,
    proposalId: "a6",
    action: "create_account",
    input: { name: "OP", broker: "op", baseCurrency: EUR, kind: "bank", accountType: "current" },
  },
  {
    ...card,
    proposalId: "a7",
    action: "edit_account",
    input: { id: 3, changes: { name: "OP savings" } },
  },
  {
    ...card,
    proposalId: "a8",
    action: "account_balance",
    input: {
      accountId: 3,
      on: "2026-11-01",
      balance: "120.50",
      expectOpeningEur: "20.50",
      expectOpeningDate: "2026-01-01",
    },
  },
  {
    ...card,
    proposalId: "a9",
    action: "create_instrument",
    input: { name: "Acme", ticker: null, kind: "stock", currency: EUR, priceSource: "manual" },
  },
  { ...card, proposalId: "a10", action: "fund_fee", input: { id: 4, percent: "0.20" } },
  {
    ...card,
    proposalId: "a11",
    action: "forecast_rate",
    input: { instrumentId: 4, ratePercent: "6.5" },
  },
  {
    ...card,
    proposalId: "a12",
    action: "snapshot",
    input: {
      accountId: 3,
      asOf: "2026-11-01",
      source: "manual",
      rows: [{ instrumentId: 4, quantity: "10" }],
    },
  },
  {
    ...card,
    proposalId: "a13",
    action: "snapshot_adjust",
    input: { snapshotId: 9, instrumentId: 4, costEur: "100", expectQuantity: "2" },
  },
  {
    ...card,
    proposalId: "a14",
    action: "spending_rules",
    input: { rules: [{ pattern: "KAHVILA", category: "restaurants" }] },
  },
  {
    ...card,
    proposalId: "a15",
    action: "spending_rule_category",
    input: { pattern: "KAHVILA", category: "groceries" },
  },
  { ...card, danger: true, proposalId: "a16", action: "delete_cash_entry", input: { id: 7 } },
  {
    ...card,
    danger: true,
    proposalId: "a17",
    action: "delete_plan_row",
    input: { instrumentId: 4 },
  },
  {
    ...card,
    danger: true,
    proposalId: "a18",
    action: "delete_spending_rule",
    input: { pattern: "KAHVILA" },
  },
  { ...card, danger: true, proposalId: "a19", action: "remove_snapshot", input: { snapshotId: 9 } },
  { ...card, danger: true, proposalId: "a20", action: "undo_import", input: { importId: 5 } },
  { ...card, danger: true, proposalId: "a21", action: "remove_conversation", input: { id: 2 } },
  {
    ...card,
    danger: true,
    proposalId: "a22",
    action: "clear_fund_fee",
    input: { id: 4, percent: "" },
  },
  {
    ...card,
    danger: true,
    proposalId: "a23",
    action: "clear_forecast_rate",
    input: { instrumentId: 4 },
  },
];

const at = (index: number): Proposal => {
  const proposal = PROPOSALS[index];
  if (proposal === undefined) throw new Error(`no proposal ${index}`);
  return proposal;
};

const withdrawal = at(1);

describe("confirmProposal", () => {
  test("every action has a case here", () => {
    expect(PROPOSALS.map((proposal) => proposal.action)).toEqual(ACTION_NAMES);
  });

  test.each(PROPOSALS.map((proposal) => [proposal.action, proposal] as const))(
    "%s runs only its own form's server function, with exactly the validated input",
    async (action, proposal) => {
      const fns = actions();
      expect(await confirmProposal(proposal, fns)).toEqual({ outcome: "saved" });
      expect(fns[action]).toHaveBeenCalledExactlyOnceWith({ data: proposal.input });
      const others = ACTION_NAMES.filter((name) => name !== action);
      expect(others.filter((name) => vi.mocked(fns[name]).mock.calls.length > 0)).toEqual([]);
    },
  );

  test("a refused save is reported with the server's message, not as saved", async () => {
    const fns = { ...actions(), cash_entry: () => Promise.reject(new Error("Account not found")) };
    expect(await confirmProposal(withdrawal, fns)).toEqual({
      outcome: "failed",
      detail: "Account not found",
    });
  });
});

describe("confirmLabel", () => {
  test("a removal never reads as a plain Confirm", () => {
    for (const proposal of PROPOSALS) {
      const label = confirmLabel(proposal.action);
      if (proposal.danger === true) expect(label).not.toBe("Confirm");
      else expect(label).toBe("Confirm");
    }
    expect(confirmLabel("undo_import")).toBe("Undo import");
    expect(confirmLabel("delete_cash_entry")).toBe("Delete");
  });
});

describe("createDecider", () => {
  test("a second Confirm while the first is saving runs the save once", async () => {
    let finish = (): void => undefined;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const decide = createDecider({ ...actions(), cash_entry: save });

    const first = decide(withdrawal, true);
    const second = decide(withdrawal, true);
    finish();

    expect(await first).toEqual({ outcome: "saved" });
    expect(await second).toBeNull();
    expect(await decide(withdrawal, false)).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
  });

  test("a double Delete removes once", async () => {
    const remove = vi.fn(() => Promise.resolve());
    const decide = createDecider({ ...actions(), delete_cash_entry: remove });
    const deletion = at(15);

    await Promise.all([decide(deletion, true), decide(deletion, true)]);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test("a failed save is final too, so the card is not saved behind a failure note", async () => {
    const save = vi.fn(() => Promise.reject(new Error("offline")));
    const decide = createDecider({ ...actions(), cash_entry: save });

    expect(await decide(withdrawal, true)).toEqual({ outcome: "failed", detail: "offline" });
    expect(await decide(withdrawal, true)).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("cardState", () => {
  test("a card from a reloaded conversation is expired: no input is kept to confirm", () => {
    expect(cardState(undefined, undefined)).toBe("expired");
    expect(cardState(withdrawal, undefined)).toBe("open");
    expect(cardState(withdrawal, { outcome: "saved" })).toBe("decided");
    expect(cardState(undefined, { outcome: "dismissed" })).toBe("decided");
  });
});
