export const anthropicStream = (
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
