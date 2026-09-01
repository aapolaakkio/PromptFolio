import { describe, expect, test } from "vitest";
import { z } from "zod";

import { DEFAULT_CHAT_MODEL } from "./models.ts";
import {
  readStream,
  runTurn,
  SYSTEM_PROMPT,
  toolDefinitions,
  type ChatClient,
  type ChatEvent,
  type ModelReply,
  type TurnParams,
} from "./runner.ts";
import type { ChatTool, ToolArgs, ToolResult } from "./tools.ts";

// The whole loop is exercised against a scripted model: no account, no
// network, no cost. `test-cloudflare-env.ts` replaces the AI binding with one
// that throws, so a regression that reached the real service would fail this
// file rather than quietly bill the user.

const says = (text: string): ModelReply => ({ text, toolCalls: [] });
const calls = (...names: string[]): ModelReply => ({
  text: "",
  toolCalls: names.map((name, index) => ({ id: `call_${index}`, name, arguments: "{}" })),
});

/** Every request the runner made, so a test can assert on what the model saw. */
type Seen = { requests: TurnParams[] };

const scripted = (replies: ModelReply[], seen: Seen = { requests: [] }): ChatClient => ({
  run: (params) => {
    seen.requests.push(params);
    const reply = replies[seen.requests.length - 1];
    if (reply === undefined) throw new Error("scripted model ran out of replies");
    return Promise.resolve(reply);
  },
});

const drain = async (events: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> => {
  const out: ChatEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
};

const stubTool = (name: string, run: (args: ToolArgs) => Promise<ToolResult>): ChatTool => ({
  name,
  description: "test",
  schema: z.object({}).strict(),
  run,
});

describe("runTurn", () => {
  test("reports each tool the model called, then the final answer", async () => {
    const client = scripted([calls("get_holdings"), says("Salkun arvo on 120,00 EUR.")]);

    const events = await drain(
      runTurn(
        client,
        [stubTool("get_holdings", () => Promise.resolve({}))],
        [{ role: "user", content: "Paljonko salkku on arvoltaan?" }],
      ),
    );

    expect(events).toEqual([
      { type: "tool", name: "get_holdings" },
      { type: "answer", text: "Salkun arvo on 120,00 EUR." },
    ]);
  });

  test("sends the model the rules that forbid it doing its own arithmetic", async () => {
    const seen: Seen = { requests: [] };
    await drain(runTurn(scripted([says("ok")], seen), [], [{ role: "user", content: "moi" }]));

    expect(seen.requests[0]?.model).toBe(DEFAULT_CHAT_MODEL);
    expect(seen.requests[0]?.messages).toEqual([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: "moi" },
    ]);
  });

  test("hands a tool's result back to the model as JSON, under the call that asked for it", async () => {
    const seen: Seen = { requests: [] };
    const client = scripted([calls("get_holdings"), says("ok")], seen);

    await drain(
      runTurn(
        client,
        [stubTool("get_holdings", () => Promise.resolve({ asOf: "2026-06-01" }))],
        [{ role: "user", content: "moi" }],
      ),
    );

    expect(seen.requests[1]?.messages.slice(2)).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_0", name: "get_holdings", arguments: "{}" }],
      },
      { role: "tool", tool_call_id: "call_0", content: '{"asOf":"2026-06-01"}' },
    ]);
  });

  test("keeps the last text when the model speaks before and after a tool call", async () => {
    const client = scripted([
      { text: "Katson.", toolCalls: [{ id: "t", name: "get_returns", arguments: "{}" }] },
      says("Tuotto oli 20,00 %."),
    ]);

    const events = await drain(
      runTurn(client, [stubTool("get_returns", () => Promise.resolve({}))], []),
    );

    expect(events.at(-1)).toEqual({ type: "answer", text: "Tuotto oli 20,00 %." });
  });

  test("hands a failing tool back to the model as a message rather than killing the turn", async () => {
    const failing = stubTool("get_holdings", () => {
      throw new Error("Päivämäärä on virheellinen");
    });
    const seen: Seen = { requests: [] };

    const events = await drain(
      runTurn(scripted([calls("get_holdings"), says("En saanut lukua.")], seen), [failing], []),
    );

    expect(seen.requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      tool_call_id: "call_0",
      content: JSON.stringify({ error: "Päivämäärä on virheellinen" }),
    });
    expect(events.at(-1)).toEqual({ type: "answer", text: "En saanut lukua." });
  });

  test("refuses a tool the model invented, and arguments the schema does not accept", async () => {
    const seen: Seen = { requests: [] };
    const client = scripted(
      [
        {
          text: "",
          toolCalls: [
            { id: "a", name: "make_money", arguments: "{}" },
            { id: "b", name: "get_holdings", arguments: '{"asOf": 12}' },
          ],
        },
        says("ok"),
      ],
      seen,
    );
    const strict = stubTool("get_holdings", () => Promise.resolve({}));

    await drain(runTurn(client, [strict], []));

    const results = seen.requests[1]?.messages.filter((m) => m.role === "tool") ?? [];
    expect(results[0]?.content).toBe(JSON.stringify({ error: "Tuntematon työkalu: make_money" }));
    expect(results[1]?.content).toContain("error");
  });

  test("gives up after ten rounds of tool calls instead of looping for ever", async () => {
    const seen: Seen = { requests: [] };
    const endless = scripted(
      Array.from({ length: 20 }, () => calls("get_holdings")),
      seen,
    );

    const events = await drain(
      runTurn(endless, [stubTool("get_holdings", () => Promise.resolve({}))], []),
    );

    expect(seen.requests).toHaveLength(10);
    expect(events.at(-1)).toEqual({
      type: "answer",
      text: "En saanut vastausta valmiiksi: työkalukutsuja tuli liikaa.",
    });
  });

  test("asks the model it was given, when one was", async () => {
    const seen: Seen = { requests: [] };
    await drain(runTurn(scripted([says("ok")], seen), [], [], undefined, "@cf/openai/gpt-oss-20b"));

    expect(seen.requests[0]?.model).toBe("@cf/openai/gpt-oss-20b");
  });

  test("stops asking once the reader has gone", async () => {
    const seen: Seen = { requests: [] };
    const abort = new AbortController();
    abort.abort();

    const events = await drain(
      runTurn(scripted([calls("get_holdings"), says("ok")], seen), [], [], abort.signal),
    );

    expect(seen.requests).toHaveLength(1);
    expect(events).toEqual([]);
  });
});

describe("toolDefinitions", () => {
  test("describes a tool the way the model expects, schema included", () => {
    const tool: ChatTool = {
      name: "get_returns",
      description: "Tuotto",
      schema: z.object({ on: z.string().optional() }).strict(),
      run: () => Promise.resolve({}),
    };

    expect(toolDefinitions([tool])).toEqual([
      {
        type: "function",
        function: {
          name: "get_returns",
          description: "Tuotto",
          parameters: expect.objectContaining({
            type: "object",
            properties: { on: { type: "string" } },
            additionalProperties: false,
          }),
        },
      },
    ]);
  });
});

const sse = (...chunks: unknown[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

describe("readStream", () => {
  test("joins chat-completion deltas into text, handing each piece on as it arrives", async () => {
    const pieces: string[] = [];
    const reply = await readStream(
      sse(
        { choices: [{ delta: { content: "Salkun " } }] },
        { choices: [{ delta: { content: "arvo." } }] },
      ),
      (text) => pieces.push(text),
    );
    expect(pieces).toEqual(["Salkun ", "arvo."]);
    expect(reply).toEqual({ text: "Salkun arvo.", toolCalls: [] });
  });

  test("assembles a tool call streamed in pieces", async () => {
    const reply = await readStream(
      sse(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "c1", function: { name: "get_holdings", arguments: "" } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"on":' } }] } }] },
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: '"2026-06-01"}' } }] } },
          ],
        },
      ),
      () => undefined,
    );
    expect(reply.toolCalls).toEqual([
      { id: "c1", name: "get_holdings", arguments: '{"on":"2026-06-01"}' },
    ]);
  });

  test("reads the older models' shape too", async () => {
    const pieces: string[] = [];
    const reply = await readStream(
      sse(
        { response: "Tuotto " },
        { response: "oli 20 %." },
        { response: "", tool_calls: [{ name: "get_returns", arguments: { on: "2026-06-01" } }] },
      ),
      (text) => pieces.push(text),
    );
    expect(pieces).toEqual(["Tuotto ", "oli 20 %."]);
    expect(reply.text).toBe("Tuotto oli 20 %.");
    expect(reply.toolCalls).toEqual([
      { id: "call_0", name: "get_returns", arguments: '{"on":"2026-06-01"}' },
    ]);
  });

  test("a chunk split across two reads is still one event", async () => {
    const encoder = new TextEncoder();
    const whole = 'data: {"choices":[{"delta":{"content":"kokonainen"}}]}\n\ndata: [DONE]\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(whole.slice(0, 20)));
        controller.enqueue(encoder.encode(whole.slice(20)));
        controller.close();
      },
    });
    expect((await readStream(stream, () => undefined)).text).toBe("kokonainen");
  });
});

describe("runTurn streaming", () => {
  test("yields each piece of the answer as a delta before the answer itself", async () => {
    const client: ChatClient = {
      run: (_params, options) => {
        options?.onDelta?.("Salkun ");
        options?.onDelta?.("arvo on 120,00 EUR.");
        return Promise.resolve(says("Salkun arvo on 120,00 EUR."));
      },
    };
    const events = await drain(runTurn(client, [], [{ role: "user", content: "moi" }]));
    expect(events).toEqual([
      { type: "delta", text: "Salkun " },
      { type: "delta", text: "arvo on 120,00 EUR." },
      { type: "answer", text: "Salkun arvo on 120,00 EUR." },
    ]);
  });

  test("deltas that arrive while a reply is pending are not lost", async () => {
    const client: ChatClient = {
      run: (_params, options) =>
        new Promise((resolve) => {
          setTimeout(() => options?.onDelta?.("myöhemmin"), 5);
          setTimeout(() => resolve(says("myöhemmin")), 10);
        }),
    };
    const events = await drain(runTurn(client, [], []));
    expect(events.map((event) => event.type)).toEqual(["delta", "answer"]);
  });
});
