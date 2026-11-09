import { describe, expect, test, vi } from "vitest";

import { EUR } from "../../core/money.ts";
import type { Proposal } from "../../server/chat/proposal-schema.ts";
import {
  cardState,
  confirmProposal,
  createDecider,
  type ProposalActions,
} from "./proposal-actions.ts";

const actions = (): ProposalActions => ({
  savePrice: vi.fn(() => Promise.resolve()),
  saveCashEntry: vi.fn(() => Promise.resolve()),
  saveTargetAllocation: vi.fn(() => Promise.resolve()),
  editInstrument: vi.fn(() => Promise.resolve()),
});

const withdrawal: Proposal = {
  proposalId: "p-1",
  action: "cash_entry",
  summary: "Record a withdrawal of 250.00 EUR from Nordnet (account #3) on 2026-11-03.",
  title: "Record a withdrawal",
  facts: [{ kind: "money", label: "Amount", amount: "250.00", currency: "EUR" }],
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

describe("createDecider", () => {
  test("a second Confirm while the first is saving runs the save once", async () => {
    let finish = (): void => undefined;
    const saveCashEntry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const decide = createDecider({ ...actions(), saveCashEntry });

    const first = decide(withdrawal, true);
    const second = decide(withdrawal, true);
    finish();

    expect(await first).toEqual({ outcome: "saved" });
    expect(await second).toBeNull();
    expect(await decide(withdrawal, false)).toBeNull();
    expect(saveCashEntry).toHaveBeenCalledTimes(1);
  });

  test("a failed save is final too, so the card is not saved behind a failure note", async () => {
    const saveCashEntry = vi.fn(() => Promise.reject(new Error("offline")));
    const decide = createDecider({ ...actions(), saveCashEntry });

    expect(await decide(withdrawal, true)).toEqual({ outcome: "failed", detail: "offline" });
    expect(await decide(withdrawal, true)).toBeNull();
    expect(saveCashEntry).toHaveBeenCalledTimes(1);
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
