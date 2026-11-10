import { describe, expect, test, vi } from "vitest";

import { EUR } from "../../core/money.ts";
import { CONVERSATION_NOT_FOUND } from "../../server/chat/conversation-errors.ts";
import type { Proposal } from "../../server/chat/proposal-schema.ts";
import { isConversationGone, settleCard } from "./chat-rules.ts";

const deposit: Proposal = {
  proposalId: "c1",
  summary: "s",
  title: "t",
  facts: [],
  action: "cash_entry",
  input: { accountId: 1, type: "DEPOSIT", tradeDate: "2026-11-02", amount: "100", currency: EUR },
};

const deps = () => ({
  decide: vi.fn(() => Promise.resolve({ outcome: "saved" as const })),
  save: vi.fn(() => Promise.resolve()),
  refresh: vi.fn(),
});

describe("settleCard", () => {
  test("records against the card's own conversation, whatever is open now", async () => {
    const run = deps();
    // The card was streamed in conversation 5; the owner has since opened another one.
    const settled = await settleCard({ proposal: deposit, conversationId: 5 }, true, run);
    expect(run.save).toHaveBeenCalledWith({
      conversationId: 5,
      proposalId: "c1",
      outcome: "saved",
    });
    expect(run.refresh).toHaveBeenCalledTimes(1);
    expect(settled).toEqual({ outcome: { outcome: "saved" }, saveError: null });
  });

  test("a second decision does nothing; a failed save is reported, and the page still refreshes", async () => {
    const refused = { ...deps(), decide: vi.fn(() => Promise.resolve(null)) };
    expect(await settleCard({ proposal: deposit, conversationId: 5 }, true, refused)).toBeNull();
    expect(refused.save).not.toHaveBeenCalled();
    expect(refused.refresh).not.toHaveBeenCalled();

    const offline = { ...deps(), save: vi.fn(() => Promise.reject(new Error("offline"))) };
    const settled = await settleCard({ proposal: deposit, conversationId: 5 }, true, offline);
    expect(settled?.saveError).toBe("offline");
    expect(offline.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("isConversationGone", () => {
  test("only the server's not-found resets the stored conversation", () => {
    expect(isConversationGone(new Error(CONVERSATION_NOT_FOUND))).toBe(true);
    expect(isConversationGone(new Error("Failed to fetch"))).toBe(false);
    expect(isConversationGone(null)).toBe(false);
  });
});
