import { describe, expect, test } from "bun:test";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta";
import { z } from "zod";

import {
  runTurn,
  SYSTEM_PROMPT,
  type ChatEvent,
  type ToolRunnerClient,
  type TurnParams,
} from "./runner";
import type { ChatTool, ToolArgs, ToolResult } from "./tools";

// The whole loop is exercised against a scripted client: no API key, no
// network, no cost. `test-network-guard.ts` (a bunfig preload) makes an
// un-stubbed fetch throw, so a regression that reached the real API would fail
// this file rather than quietly bill the user.

/**
 * A whole `BetaMessage`, built from just the content blocks a test cares about.
 * The rest of the fields are the API's own constants, filled in here so the
 * scripted client hands the runner exactly the type the SDK would.
 */
const message = (content: BetaMessage["content"]): BetaMessage => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content,
  stop_reason: "end_turn",
  stop_sequence: null,
  container: null,
  context_management: null,
  diagnostics: null,
  stop_details: null,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    cache_creation: null,
    server_tool_use: null,
    service_tier: null,
    fallback_credit: null,
    inference_geo: null,
    iterations: null,
    output_tokens_details: null,
    speed: null,
  },
});

/** What the runner sent to the SDK, captured so a test can assert on it. */
type Seen = { params: TurnParams | null };

const clientYielding = (
  messages: BetaMessage[],
  seen: Seen = { params: null },
): ToolRunnerClient => ({
  beta: {
    messages: {
      toolRunner: (params: TurnParams) => {
        seen.params = params;
        return {
          async *[Symbol.asyncIterator]() {
            yield* messages;
          },
        };
      },
    },
  },
});

const drain = async (events: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> => {
  const out: ChatEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
};

const stubTool = (name: string, run: (args: ToolArgs) => ToolResult): ChatTool => ({
  name,
  description: "test",
  schema: z.object({}).strict(),
  run,
});

describe("runTurn", () => {
  test("reports each tool the model called, then the final answer", async () => {
    const client = clientYielding([
      message([{ type: "tool_use", id: "t1", name: "get_holdings", input: {} }]),
      message([{ type: "text", text: "Salkun arvo on 120,00 EUR.", citations: null }]),
    ]);

    const events = await drain(
      runTurn(
        client,
        [stubTool("get_holdings", () => ({}))],
        [{ role: "user", content: "Paljonko salkku on arvoltaan?" }],
      ),
    );

    expect(events).toEqual([
      { type: "tool", name: "get_holdings" },
      { type: "answer", text: "Salkun arvo on 120,00 EUR." },
    ]);
  });

  test("sends the model the rules that forbid it doing its own arithmetic", async () => {
    const seen: Seen = { params: null };
    const client = clientYielding([message([{ type: "text", text: "ok", citations: null }])], seen);

    await drain(runTurn(client, [], [{ role: "user", content: "moi" }]));

    expect(seen.params?.system).toEqual([
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ]);
    expect(seen.params?.model).toBe("claude-sonnet-5");
    expect(seen.params?.thinking).toEqual({ type: "adaptive" });
  });

  test("marks the head and the tail of the request as cacheable", async () => {
    const seen: Seen = { params: null };
    const client = clientYielding([message([{ type: "text", text: "ok", citations: null }])], seen);

    await drain(
      runTurn(
        client,
        [],
        [
          { role: "user", content: "eka" },
          { role: "assistant", content: "vastaus" },
          { role: "user", content: "toka" },
        ],
      ),
    );

    // The head: system carries the breakpoint, and the prefix is ordered tools
    // then system, so the tool schemas are cached with it.
    expect(seen.params?.system).toEqual([
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ]);
    // The tail: only the newest message is marked. Marking an earlier one would
    // cache a prefix the next turn no longer ends at.
    expect(seen.params?.messages[0]?.content).toBe("eka");
    expect(seen.params?.messages[1]?.content).toBe("vastaus");
    expect(seen.params?.messages[2]?.content).toEqual([
      { type: "text", text: "toka", cache_control: { type: "ephemeral" } },
    ]);
  });

  test("keeps the last text when the model speaks before and after a tool call", async () => {
    const client = clientYielding([
      message([
        { type: "text", text: "Katson.", citations: null },
        { type: "tool_use", id: "t", name: "get_returns", input: {} },
      ]),
      message([{ type: "text", text: "Tuotto oli 20,00 %.", citations: null }]),
    ]);

    const events = await drain(runTurn(client, [stubTool("get_returns", () => ({}))], []));

    expect(events.at(-1)).toEqual({ type: "answer", text: "Tuotto oli 20,00 %." });
  });

  test("hands a failing tool back to the model as a message rather than killing the turn", async () => {
    const failing = stubTool("get_holdings", () => {
      throw new Error("Päivämäärä on virheellinen");
    });
    const seen: Seen = { params: null };
    const client = clientYielding(
      [message([{ type: "text", text: "En saanut lukua.", citations: null }])],
      seen,
    );

    await drain(runTurn(client, [failing], []));

    // The SDK-side runnable is what the model actually calls, so the failure
    // path is checked through it rather than through our own tool object.
    const result = await seen.params?.tools[0]?.run({});
    expect(result).toBe(JSON.stringify({ error: "Päivämäärä on virheellinen" }));
  });

  test("serialises a tool's result as the JSON the model reads", async () => {
    const seen: Seen = { params: null };
    const client = clientYielding([message([{ type: "text", text: "ok", citations: null }])], seen);

    await drain(runTurn(client, [stubTool("get_holdings", () => ({ asOf: "2026-06-01" }))], []));

    expect(await seen.params?.tools[0]?.run({})).toBe('{"asOf":"2026-06-01"}');
  });
});
