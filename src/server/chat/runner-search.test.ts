import { describe, expect, test } from "vitest";
import { z } from "zod";

import { anthropicSearchStream, anthropicStream } from "./anthropic-stream-fixture.ts";
import {
  createClient,
  runTurn,
  type ChatClient,
  type ChatEvent,
  type TurnParams,
} from "./runner.ts";
import type { ChatTool } from "./tool-types.ts";

// Web search runs on Anthropic's side; here a fake Messages API plays both the model and the search.

const Body = z.looseObject({
  system: z.string().optional(),
  tools: z.array(z.looseObject({ name: z.string() })).optional(),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]),
    }),
  ),
});

const fakeAnthropic = (...responses: Response[]) => {
  const bodies: z.infer<typeof Body>[] = [];
  const fetchImpl: typeof fetch = (_input, init) => {
    bodies.push(Body.parse(JSON.parse(z.string().parse(init?.body))));
    const next = responses.shift();
    if (next === undefined) throw new Error("fake Anthropic ran out of responses");
    return Promise.resolve(next);
  };
  return { fetchImpl, bodies };
};

const drain = async (events: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> => {
  const out: ChatEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
};

const recording = (): ChatClient & { readonly seen: TurnParams[] } => {
  const seen: TurnParams[] = [];
  return {
    seen,
    run: (params) => {
      seen.push(params);
      return Promise.resolve({ text: "ok", toolCalls: [] });
    },
  };
};

const ask = [{ role: "user" as const, content: "What was the tender offer price?" }];
const SEARCH_ON = { ownerName: null };
const RULE = "Search only when the answer needs a public fact";

const SOURCE = { title: "Offer document <b>", url: "https://example.com/offer" };

const holdingsTool: ChatTool = {
  name: "get_holdings",
  description: "test",
  schema: z.object({}).strict(),
  run: () => Promise.resolve({ value: "1.00" }),
};

describe("web search switch", () => {
  test("off: the request has no search tool and the prompt no search rules", async () => {
    const client = recording();
    await drain(runTurn(client, [], ask));

    const [params] = client.seen;
    expect(params?.tools.map((tool) => tool.name)).not.toContain("web_search");
    expect(params?.messages[0]?.content).not.toContain(RULE);
  });

  test("on: the search tool is in the request, three uses, called directly", async () => {
    const client = recording();
    await drain(runTurn(client, [], ask, undefined, undefined, null, SEARCH_ON));

    const [params] = client.seen;
    expect(params?.tools).toContainEqual({
      type: "web_search_20260318",
      name: "web_search",
      max_uses: 3,
      allowed_callers: ["direct"],
    });
    expect(params?.messages[0]?.content).toContain(RULE);
    expect(params?.messages[0]?.content).toContain("Never put into a query");
  });

  test("on: the tool reaches the Messages API body", async () => {
    const api = fakeAnthropic(anthropicStream("ok"));
    await drain(
      runTurn(createClient(api.fetchImpl), [], ask, undefined, undefined, null, SEARCH_ON),
    );

    expect(api.bodies[0]?.tools?.map((tool) => tool.name)).toEqual(["web_search"]);
  });
});

describe("a streamed answer with a search", () => {
  test("yields the search, then its cited sources, then the answer", async () => {
    const api = fakeAnthropic(
      anthropicSearchStream({
        searches: [{ id: "srvtoolu_1", query: "Acme Oyj tender offer price", results: [SOURCE] }],
        text: "The offer was 4.20 EUR.",
        cited: [SOURCE],
      }),
    );
    const events = await drain(
      runTurn(createClient(api.fetchImpl), [], ask, undefined, undefined, null, SEARCH_ON),
    );

    const web = events.filter((event) =>
      ["search", "search_failed", "sources"].includes(event.type),
    );
    expect(web).toEqual([
      { type: "search", id: "srvtoolu_1", query: "Acme Oyj tender offer price", personal: false },
      { type: "sources", sources: [SOURCE] },
    ]);
    expect(events.at(-1)).toEqual({ type: "answer", text: "The offer was 4.20 EUR." });
  });

  test("a search error is a failure line, and the answer goes on", async () => {
    const api = fakeAnthropic(
      anthropicSearchStream({
        searches: [{ id: "srvtoolu_1", query: "Acme Oyj", error: "too_many_requests" }],
        text: "I could not check the web.",
      }),
    );
    const events = await drain(
      runTurn(createClient(api.fetchImpl), [], ask, undefined, undefined, null, SEARCH_ON),
    );

    expect(events).toContainEqual({
      type: "search_failed",
      id: "srvtoolu_1",
      reason: "too many searches right now",
    });
    expect(events.at(-1)).toEqual({ type: "answer", text: "I could not check the web." });
  });

  test("a query holding personal data is flagged, not hidden", async () => {
    const api = fakeAnthropic(
      anthropicSearchStream({
        searches: [{ id: "srvtoolu_1", query: "Maija Meikäläinen FI21 1234 5600 0007 85" }],
        text: "Done.",
      }),
    );
    const events = await drain(
      runTurn(createClient(api.fetchImpl), [], ask, undefined, undefined, null, {
        ownerName: "Maija Meikäläinen",
      }),
    );

    expect(events).toContainEqual({
      type: "search",
      id: "srvtoolu_1",
      query: "Maija Meikäläinen FI21 1234 5600 0007 85",
      personal: true,
    });
  });

  test("the search blocks go back unchanged on the round after a client tool call", async () => {
    const api = fakeAnthropic(
      anthropicSearchStream({
        searches: [{ id: "srvtoolu_1", query: "Acme Oyj", results: [SOURCE] }],
        text: "Checking your holdings too.",
        cited: [SOURCE],
        tools: [{ id: "toolu_1", name: "get_holdings", input: {} }],
      }),
      anthropicStream("You hold Acme."),
    );
    const events = await drain(
      runTurn(
        createClient(api.fetchImpl),
        [holdingsTool],
        ask,
        undefined,
        undefined,
        null,
        SEARCH_ON,
      ),
    );

    const replayed = api.bodies[1]?.messages[1]?.content;
    expect(replayed).toEqual([
      { type: "thinking", thinking: "", signature: "sig" },
      {
        type: "server_tool_use",
        id: "srvtoolu_1",
        name: "web_search",
        input: { query: "Acme Oyj" },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "srvtoolu_1",
        content: [
          { type: "web_search_result", ...SOURCE, encrypted_content: "enc-0", page_age: null },
        ],
      },
      {
        type: "text",
        text: "Checking your holdings too.",
        citations: [
          {
            type: "web_search_result_location",
            ...SOURCE,
            cited_text: "cited",
            encrypted_index: "idx",
          },
        ],
      },
      { type: "tool_use", id: "toolu_1", name: "get_holdings", input: {} },
    ]);
    expect(events.filter((event) => event.type === "search")).toHaveLength(1);
  });

  test("a paused turn is continued by sending the paused reply back, with no new question", async () => {
    const api = fakeAnthropic(
      anthropicSearchStream({
        searches: [{ id: "srvtoolu_1", query: "Acme Oyj", results: [SOURCE] }],
        text: "",
        stopReason: "pause_turn",
      }),
      anthropicStream("The offer was 4.20 EUR."),
    );
    const events = await drain(
      runTurn(createClient(api.fetchImpl), [], ask, undefined, undefined, null, SEARCH_ON),
    );

    expect(api.bodies).toHaveLength(2);
    const sent = api.bodies[1]?.messages ?? [];
    expect(sent.map((message) => message.role)).toEqual(["user", "assistant"]);
    const paused = sent[1]?.content;
    expect(Array.isArray(paused) ? paused.map((block) => block.type) : paused).toEqual([
      "thinking",
      "server_tool_use",
      "web_search_tool_result",
      "text",
    ]);
    expect(events.at(-1)).toEqual({ type: "answer", text: "The offer was 4.20 EUR." });
  });
});
