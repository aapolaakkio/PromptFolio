import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import type { ChatClient, ModelReply, TurnParams } from "../chat/runner.ts";
import { explainGaps, type GapInput, MAX_GAP_ROWS } from "./explain-gap.ts";

const scripted = (text: string): ChatClient & { asked: TurnParams[] } => {
  const asked: TurnParams[] = [];
  return {
    asked,
    run: async (params): Promise<ModelReply> => {
      asked.push(params);
      return { text, toolCalls: [] };
    },
  };
};

const GAP: GapInput = {
  instrumentId: 7,
  name: "NOKIA",
  isin: "FI0009000681",
  ledger: "100.000000",
  statement: "1000.000000",
  delta: "900.000000",
  txns: [{ date: "2024-03-01", type: "BUY", quantity: "100.000000" }],
};
const ASOF = "2024-06-30";

type Adjustment = { type: string; tradeDate: string; quantity: string };
const answer = (
  over: { id?: number; category?: string; cause?: string; adjustment?: Adjustment | null } = {},
) => ({
  id: 0,
  category: "unbooked split",
  cause: "The 1:10 split of June 2024 is not booked.",
  adjustment: { type: "TRANSFER_IN", tradeDate: "2024-06-30", quantity: "900" },
  ...over,
});
const reply = (...rows: readonly object[]) => JSON.stringify({ rows });

describe("explainGaps", () => {
  test("a gap equal to a split factor gets a cause and an adjustment equal to the gap", async () => {
    const out = await explainGaps(scripted(reply(answer())), ASOF, [GAP]);
    expect(out.failed).toBe(false);
    expect(out.explanations).toEqual([
      {
        instrumentId: 7,
        cause: "The 1:10 split of June 2024 is not booked.",
        category: "unbooked split",
        adjustment: { type: "TRANSFER_IN", tradeDate: "2024-06-30", quantity: "900.000000" },
      },
    ]);
  });

  test("a quantity that is not the gap drops the adjustment but keeps the sentence", async () => {
    const adjustment = { type: "TRANSFER_IN", tradeDate: "2024-06-30", quantity: "899.999999" };
    const out = await explainGaps(scripted(reply(answer({ adjustment }))), ASOF, [GAP]);
    expect(out.explanations[0]?.adjustment).toBeNull();
    expect(out.explanations[0]?.cause).toContain("split");
  });

  test("the sign must match: an unsigned quantity for a negative gap is dropped", async () => {
    const gap = { ...GAP, ledger: "1000.000000", statement: "100.000000", delta: "-900.000000" };
    const wrongSign = { type: "TRANSFER_OUT", tradeDate: ASOF, quantity: "900" };
    const right = { type: "TRANSFER_OUT", tradeDate: ASOF, quantity: "-900" };
    const dropped = await explainGaps(scripted(reply(answer({ adjustment: wrongSign }))), ASOF, [
      gap,
    ]);
    const kept = await explainGaps(scripted(reply(answer({ adjustment: right }))), ASOF, [gap]);
    expect(dropped.explanations[0]?.adjustment).toBeNull();
    expect(kept.explanations[0]?.adjustment?.quantity).toBe("-900.000000");
  });

  test("the direction must follow the gap: adding units for a negative gap is dropped", async () => {
    const gap = { ...GAP, delta: "-900.000000" };
    const adjustment = { type: "TRANSFER_IN", tradeDate: ASOF, quantity: "-900" };
    const out = await explainGaps(scripted(reply(answer({ adjustment }))), ASOF, [gap]);
    expect(out.explanations[0]?.adjustment).toBeNull();
  });

  test.each([
    ["a type AdjustRow does not allow", { type: "BUY", tradeDate: ASOF, quantity: "900" }],
    [
      "a date after the statement",
      { type: "TRANSFER_IN", tradeDate: "2024-07-01", quantity: "900" },
    ],
    ["an impossible date", { type: "TRANSFER_IN", tradeDate: "2024-02-30", quantity: "900" }],
    ["a comma quantity", { type: "TRANSFER_IN", tradeDate: ASOF, quantity: "900,0" }],
    ["an exponent quantity", { type: "TRANSFER_IN", tradeDate: ASOF, quantity: "9e2" }],
  ])("%s drops the adjustment, keeps the sentence", async (_name, adjustment) => {
    const out = await explainGaps(scripted(reply(answer({ adjustment }))), ASOF, [GAP]);
    expect(out.explanations).toHaveLength(1);
    expect(out.explanations[0]?.adjustment).toBeNull();
  });

  test("a sentence-only answer is kept", async () => {
    const out = await explainGaps(scripted(reply(answer({ adjustment: null }))), ASOF, [GAP]);
    expect(out.explanations[0]?.adjustment).toBeNull();
  });

  test("an unknown or repeated id is ignored", async () => {
    const out = await explainGaps(scripted(reply(answer({ id: 5 }), answer(), answer())), ASOF, [
      GAP,
    ]);
    expect(out.explanations).toHaveLength(1);
  });

  test("the prompt carries no euro amount, account number or price", async () => {
    const client = scripted(reply(answer()));
    const gap = { ...GAP, name: "Fund FI21 1234 5600 0007 85" };
    await explainGaps(client, ASOF, [gap]);
    const sent = client.asked.map((p) => p.messages.map((m) => m.content).join("\n")).join("\n");
    expect(sent).not.toMatch(/€|amount|price|cost|fee/i);
    expect(sent).not.toContain("1234 5600");
    expect(sent).toContain("FI0009000681");
    expect(sent).toContain("2024-03-01");
    expect(client.asked[0]?.tools).toEqual([]);
  });

  test("a failing model gives a flag, not a throw, and logs only the error name", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client: ChatClient = {
      run: () => Promise.reject(new TypeError("NOKIA 900 secret")),
    };
    const out = await explainGaps(client, ASOF, [GAP]);
    expect(out).toEqual({ failed: true, explanations: [], truncated: false });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    warn.mockRestore();
  });

  test("a reply that is not the asked shape counts as a failure", async () => {
    const out = await explainGaps(scripted("no idea"), ASOF, [GAP]);
    expect(out).toEqual({ failed: true, explanations: [], truncated: false });
  });

  test("no rows means no call", async () => {
    const client = scripted(reply());
    expect(await explainGaps(client, ASOF, [])).toEqual({
      failed: false,
      explanations: [],
      truncated: false,
    });
    expect(client.asked).toHaveLength(0);
  });

  test("asks about at most MAX_GAP_ROWS rows", async () => {
    const client = scripted(reply());
    const many = Array.from({ length: MAX_GAP_ROWS + 5 }, (_, i) => ({ ...GAP, instrumentId: i }));
    await explainGaps(client, ASOF, many);
    const asked = z
      .object({ rows: z.array(z.object({ id: z.number() })) })
      .parse(JSON.parse(client.asked[0]?.messages[1]?.content ?? "{}"));
    expect(asked.rows).toHaveLength(MAX_GAP_ROWS);
  });

  test("one malformed row does not cost the good one", async () => {
    const bad = { id: 1, category: "nonsense", cause: 5 };
    const out = await explainGaps(scripted(reply(bad, answer())), ASOF, [GAP]);
    expect(out.failed).toBe(false);
    expect(out.explanations).toHaveLength(1);
  });

  test("an over-long cause is truncated, not fatal", async () => {
    const out = await explainGaps(scripted(reply(answer({ cause: "x".repeat(500) }))), ASOF, [GAP]);
    expect(out.explanations[0]?.cause).toHaveLength(300);
  });

  test("says when rows beyond the cap were left out", async () => {
    const many = Array.from({ length: MAX_GAP_ROWS + 1 }, (_, i) => ({ ...GAP, instrumentId: i }));
    expect((await explainGaps(scripted(reply()), ASOF, many)).truncated).toBe(true);
    expect((await explainGaps(scripted(reply()), ASOF, [GAP])).truncated).toBe(false);
  });

  test.each(["duplicate import", "statement in another unit", "unclear"])(
    "a %s cause keeps the sentence but offers no adjustment",
    async (category) => {
      const out = await explainGaps(scripted(reply(answer({ category }))), ASOF, [GAP]);
      expect(out.explanations[0]?.adjustment).toBeNull();
      expect(out.explanations[0]?.cause).toContain("split");
    },
  );
});
