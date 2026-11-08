import { describe, expect, test } from "vitest";
import { z } from "zod";
import { env } from "cloudflare:workers";

import { DEFAULT_CHAT_MODEL } from "./models.ts";
import {
  createClient,
  runTurn,
  SYSTEM_PROMPT,
  toolDefinitions,
  type ChatClient,
  type ChatEvent,
  type ModelReply,
  type TurnParams,
} from "./runner.ts";
import type { ChatTool, ToolArgs, ToolResult } from "./tools.ts";

// The whole loop is exercised against a scripted model, and the client against
// a fake Messages API: no account, no network, no cost. The global fetch throws
// (test-network-guard.ts), so a regression that reached the real service would
// fail this file rather than quietly bill the user.

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
    await drain(runTurn(scripted([says("ok")], seen), [], [], undefined, "claude-haiku-5-5"));

    expect(seen.requests[0]?.model).toBe("claude-haiku-5-5");
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

/** A Messages API stream that says `text` and calls `tools`, in SSE form. */
const anthropicStream = (
  text: string,
  tools: { id: string; name: string; input: unknown }[] = [],
  stopReason = tools.length > 0 ? "tool_use" : "end_turn",
): Response => {
  const events: { event: string; data: unknown }[] = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig" },
      },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      },
    },
    ...text.split(" ").map((word, at) => ({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: at === 0 ? word : ` ${word}` },
      },
    })),
    { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
    ...tools.flatMap((tool, at) => [
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: 2 + at,
          content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
        },
      },
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: 2 + at,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) },
        },
      },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 2 + at } },
    ]),
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
  const body = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
};

/** The parts of a Messages API request body the tests look at. */
const RequestBody = z.looseObject({
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]),
    }),
  ),
});

/** A fetch that records each request body and answers with the given responses in turn. */
const fakeAnthropic = (...responses: Response[]) => {
  const bodies: z.infer<typeof RequestBody>[] = [];
  const urls: string[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    urls.push(input instanceof Request ? input.url : String(input));
    bodies.push(RequestBody.parse(JSON.parse(z.string().parse(init?.body))));
    const next = responses.shift();
    if (next === undefined) throw new Error("fake Anthropic ran out of responses");
    return Promise.resolve(next);
  };
  return { fetchImpl, bodies, urls };
};

describe("createClient", () => {
  test("sends the Messages API shape: system on top, tool results as user turns", async () => {
    const api = fakeAnthropic(anthropicStream("valmis"));
    await createClient(api.fetchImpl).run({
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [
        { role: "system", content: "ohje" },
        { role: "user", content: "moi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "toolu_1", name: "laske", arguments: '{"a":1}' }],
        },
        { role: "tool", tool_call_id: "toolu_1", content: '{"ok":true}' },
      ],
      tools: [],
    });

    const body = api.bodies[0];
    expect(body?.system).toBe("ohje");
    expect(body?.messages).toEqual([
      { role: "user", content: "moi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "laske", input: { a: 1 } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: '{"ok":true}' }],
      },
    ]);
    expect(body).not.toHaveProperty("tools");
    expect(body?.thinking).toEqual({ type: "adaptive" });
    expect(body?.fallbacks).toBe("default");
    expect(api.urls[0]).toContain("api.anthropic.com");
  });

  test("asks for structured output when given a schema, and skips fallbacks on Haiku", async () => {
    const api = fakeAnthropic(anthropicStream("{}"));
    await createClient(api.fetchImpl).run({
      model: "claude-haiku-5-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "moi" }],
      tools: [],
      response_format: {
        type: "json_schema",
        json_schema: z.toJSONSchema(z.object({ ok: z.boolean() })),
      },
    });

    const body = api.bodies[0];
    expect(body?.output_config).toMatchObject({
      format: { type: "json_schema", schema: expect.objectContaining({ type: "object" }) },
    });
    expect(body).not.toHaveProperty("fallbacks");
  });

  test("streams text, returns tool calls, and keeps the raw blocks for replay", async () => {
    const api = fakeAnthropic(
      anthropicStream("katsotaan salkku", [{ id: "toolu_9", name: "get_holdings", input: {} }]),
    );
    const pieces: string[] = [];
    const reply = await createClient(api.fetchImpl).run(
      {
        model: "claude-opus-5-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "moi" }],
        tools: [],
      },
      { onDelta: (text) => pieces.push(text) },
    );

    expect(pieces.join("")).toBe("katsotaan salkku");
    expect(reply.text).toBe("katsotaan salkku");
    expect(reply.toolCalls).toEqual([{ id: "toolu_9", name: "get_holdings", arguments: "{}" }]);
    expect(reply.blocks?.map((block) => block.type)).toEqual(["thinking", "text", "tool_use"]);
  });

  test("a turn replays the model's own blocks, thinking included, on the next round", async () => {
    const api = fakeAnthropic(
      anthropicStream("", [{ id: "toolu_1", name: "get_holdings", input: {} }]),
      anthropicStream("Arvo on 1,00 EUR."),
    );
    const tool = stubTool("get_holdings", () => Promise.resolve({ value: "1.00" }));
    await drain(runTurn(createClient(api.fetchImpl), [tool], [{ role: "user", content: "moi" }]));

    const replayed = api.bodies[1]?.messages[1]?.content;
    expect(Array.isArray(replayed) ? replayed.map((block) => block.type) : replayed).toEqual([
      "thinking",
      "text",
      "tool_use",
    ]);
  });

  test("drops tool calls from a reply cut off at max_tokens", async () => {
    const api = fakeAnthropic(
      anthropicStream("", [{ id: "toolu_1", name: "laske", input: {} }], "max_tokens"),
    );
    const reply = await createClient(api.fetchImpl).run({
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "moi" }],
      tools: [],
    });
    expect(reply.toolCalls).toEqual([]);
  });

  test("a refusal is an error, not an empty answer", async () => {
    const api = fakeAnthropic(anthropicStream("", [], "refusal"));
    await expect(
      createClient(api.fetchImpl).run({
        model: "claude-opus-5-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "moi" }],
        tools: [],
      }),
    ).rejects.toThrow("kieltäytyi");
  });

  test("goes through AI Gateway when one is named", async () => {
    const api = fakeAnthropic(anthropicStream("ok"));
    const previous = { AI: env.AI, AI_GATEWAY_ID: env.AI_GATEWAY_ID };
    Object.assign(env, {
      AI_GATEWAY_ID: "promptfolio",
      AI: {
        gateway: (id: string) => ({
          getUrl: (provider: string) =>
            Promise.resolve(`https://gateway.ai.cloudflare.com/v1/acct/${id}/${provider}`),
        }),
      },
    });
    try {
      await createClient(api.fetchImpl).run({
        model: "claude-opus-5-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "moi" }],
        tools: [],
      });
      expect(api.urls[0]).toBe(
        "https://gateway.ai.cloudflare.com/v1/acct/promptfolio/anthropic/v1/messages",
      );
    } finally {
      Object.assign(env, previous);
    }
  });

  test("refuses with a 503 when no key is configured", () => {
    const previous = env.ANTHROPIC_API_KEY;
    Object.assign(env, { ANTHROPIC_API_KEY: "" });
    try {
      expect(() => createClient()).toThrow("ANTHROPIC_API_KEY");
    } finally {
      Object.assign(env, { ANTHROPIC_API_KEY: previous });
    }
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
        name: "get_returns",
        description: "Tuotto",
        input_schema: expect.objectContaining({
          type: "object",
          properties: { on: { type: "string" } },
          additionalProperties: false,
        }),
      },
    ]);
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
