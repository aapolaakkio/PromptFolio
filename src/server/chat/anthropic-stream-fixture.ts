import type { z } from "zod";

type Json = z.infer<ReturnType<typeof z.json>>;
type SseEvent = { readonly event: string; readonly data: unknown };
/** A content block or delta as the API streams it: a type and its fields. */
type Wire = { readonly type: string; readonly [field: string]: Json };

export type FixtureTool = { readonly id: string; readonly name: string; readonly input: unknown };
export type FixtureSource = { readonly title: string; readonly url: string };
/** One web search: its results, or the API's error code in place of them. */
export type FixtureSearch = {
  readonly id: string;
  readonly query: string;
  readonly results?: readonly FixtureSource[];
  readonly error?: string;
};

const start = (index: number, block: Wire): SseEvent => ({
  event: "content_block_start",
  data: { type: "content_block_start", index, content_block: block },
});
const delta = (index: number, body: Wire): SseEvent => ({
  event: "content_block_delta",
  data: { type: "content_block_delta", index, delta: body },
});
const stop = (index: number): SseEvent => ({
  event: "content_block_stop",
  data: { type: "content_block_stop", index },
});

const messageStart: SseEvent = {
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
};

const thinking = (index: number): SseEvent[] => [
  start(index, { type: "thinking", thinking: "", signature: "" }),
  delta(index, { type: "signature_delta", signature: "sig" }),
  stop(index),
];

const citation = (source: FixtureSource) => ({
  type: "citations_delta",
  citation: {
    type: "web_search_result_location",
    url: source.url,
    title: source.title,
    cited_text: "cited",
    encrypted_index: "idx",
  },
});

const textBlock = (index: number, text: string, cited: readonly FixtureSource[]): SseEvent[] => [
  start(index, { type: "text", text: "" }),
  ...text
    .split(" ")
    .map((word, at) => delta(index, { type: "text_delta", text: at === 0 ? word : ` ${word}` })),
  ...cited.map((source) => delta(index, citation(source))),
  stop(index),
];

const toolBlocks = (first: number, tools: readonly FixtureTool[]): SseEvent[] =>
  tools.flatMap((tool, at) => [
    start(first + at, { type: "tool_use", id: tool.id, name: tool.name, input: {} }),
    delta(first + at, { type: "input_json_delta", partial_json: JSON.stringify(tool.input) }),
    stop(first + at),
  ]);

const resultContent = (search: FixtureSearch, at: number) =>
  search.error === undefined
    ? (search.results ?? []).map((source) => ({
        type: "web_search_result",
        title: source.title,
        url: source.url,
        encrypted_content: `enc-${at}`,
        page_age: null,
      }))
    : { type: "web_search_tool_result_error", error_code: search.error };

const searchBlocks = (first: number, searches: readonly FixtureSearch[]): SseEvent[] =>
  searches.flatMap((search, at) => {
    const use = first + at * 2;
    const query = JSON.stringify({ query: search.query });
    return [
      start(use, { type: "server_tool_use", id: search.id, name: "web_search", input: {} }),
      delta(use, { type: "input_json_delta", partial_json: query }),
      stop(use),
      start(use + 1, {
        type: "web_search_tool_result",
        tool_use_id: search.id,
        content: resultContent(search, at),
      }),
      stop(use + 1),
    ];
  });

const messageEnd = (stopReason: string): SseEvent[] => [
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

const sse = (events: readonly SseEvent[]): Response =>
  new Response(
    events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

export const anthropicStream = (
  text: string,
  tools: FixtureTool[] = [],
  stopReason = tools.length > 0 ? "tool_use" : "end_turn",
): Response =>
  sse([
    messageStart,
    ...thinking(0),
    ...textBlock(1, text, []),
    ...toolBlocks(2, tools),
    ...messageEnd(stopReason),
  ]);

type SearchReply = {
  readonly searches: readonly FixtureSearch[];
  readonly text: string;
  /** Sources the text cites; each becomes a citation on the text block. */
  readonly cited?: readonly FixtureSource[];
  readonly tools?: readonly FixtureTool[];
  readonly stopReason?: string;
};

/** A reply that ran web searches before it spoke: server_tool_use and result blocks, then cited text. */
export const anthropicSearchStream = ({
  searches,
  text,
  cited = [],
  tools = [],
  stopReason = tools.length > 0 ? "tool_use" : "end_turn",
}: SearchReply): Response => {
  const textAt = 1 + searches.length * 2;
  return sse([
    messageStart,
    ...thinking(0),
    ...searchBlocks(1, searches),
    ...textBlock(textAt, text, cited),
    ...toolBlocks(textAt + 1, tools),
    ...messageEnd(stopReason),
  ]);
};
