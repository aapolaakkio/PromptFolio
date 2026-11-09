import { describe, expect, test, vi } from "vitest";

import { EUR } from "../../core/money.ts";
import type { Proposal } from "../../server/chat/proposal-schema.ts";
import { cardState, confirmProposal, type ProposalActions } from "./proposal-actions.ts";

const actions = (): ProposalActions => ({
  savePrice: vi.fn(() => Promise.resolve()),
  saveCashEntry: vi.fn(() => Promise.resolve()),
  saveTargetAllocation: vi.fn(() => Promise.resolve()),
  editInstrument: vi.fn(() => Promise.resolve()),
});

const withdrawal: Proposal = {
  proposalId: "p-1",
  action: "cash_entry",
  summary: "Record a withdrawal of 250.00 EUR from Nordnet on 2026-11-03.",
  input: {
    accountId: 3,
    type: "WITHDRAWAL",
    tradeDate: "2026-11-03",
    amount: "250",
    currency: EUR,
  },
};

describe("confirmProposal", () => {
  test("sends the validated input unchanged to the form's own server function", async () => {
    const fns = actions();
    expect(await confirmProposal(withdrawal, fns)).toEqual({ outcome: "saved" });
    expect(fns.saveCashEntry).toHaveBeenCalledWith({ data: withdrawal.input });
    expect(fns.savePrice).not.toHaveBeenCalled();
  });

  test("a refused save is reported with the server's message, not as saved", async () => {
    const fns = {
      ...actions(),
      saveCashEntry: () => Promise.reject(new Error("Account not found")),
    };
    expect(await confirmProposal(withdrawal, fns)).toEqual({
      outcome: "failed",
      detail: "Account not found",
    });
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
