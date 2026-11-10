import type { BetaContentBlock } from "@anthropic-ai/sdk/resources/beta";
import { beforeAll, describe, expect, test } from "vitest";

import { db } from "../db/index.ts";
import { chatMessages } from "../db/schema.ts";
import { withOwnerName } from "./owner-name.ts";
import type { ChatClient, TurnParams } from "./runner.ts";
import { StoredSearchSchema } from "./search-schema.ts";

// A search turn is stored as one `search` row beside the answer; the model never reads it back.

type Conversations = typeof import("./conversations.ts");

let auth: ReturnType<(typeof import("../auth.ts"))["getAuth"]>;
let chat: Conversations;

beforeAll(async () => {
  auth = (await import("../auth.ts")).getAuth();
  chat = await import("./conversations.ts");
});

const signUp = async (): Promise<string> => {
  const response = await auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Maija Meikäläinen",
        email: `chat-search-${crypto.randomUUID()}@example.com`,
        password: "correct horse battery staple",
      }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed with status ${response.status}`);
  // SAFETY: a 200 from POST /sign-up/email carries `{ token, user: { id } }`.
  const body = (await response.json()) as { user: { id: string } };
  return body.user.id;
};

const SOURCE = { title: "Offer document", url: "https://example.com/offer" };

const searchBlocks = (query: string): BetaContentBlock[] => [
  { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query } },
  {
    type: "web_search_tool_result",
    tool_use_id: "srvtoolu_1",
    content: [{ type: "web_search_result", ...SOURCE, encrypted_content: "enc", page_age: null }],
  },
  {
    type: "text",
    text: "The offer was 4.20 EUR.",
    citations: [
      { type: "web_search_result_location", ...SOURCE, cited_text: "4.20", encrypted_index: "i" },
    ],
  },
];

const recording = (blocks: BetaContentBlock[] = []): ChatClient & { seen: TurnParams[] } => {
  const seen: TurnParams[] = [];
  return {
    seen,
    run: (params) => {
      seen.push(params);
      return Promise.resolve({ text: "The offer was 4.20 EUR.", toolCalls: [], blocks });
    },
  };
};

const never = new AbortController().signal;

const idOf = async (stream: ReadableStream<Uint8Array>): Promise<number> => {
  const text = await new Response(stream).text();
  const match = /"type":"conversation","id":(\d+)/.exec(text);
  if (match?.[1] === undefined) throw new Error("no conversation id streamed");
  return Number(match[1]);
};

const toolNames = (params: TurnParams | undefined) => params?.tools.map((tool) => tool.name);

describe("a turn with web search", () => {
  test("left out, the switch is off: the model is offered no search", async () => {
    const client = recording();
    chat._setChatClient(client);
    const userId = await signUp();
    await idOf(await chat.startTurn(userId, { message: "Price?" }, never));
    chat._setChatClient(null);

    expect(toolNames(client.seen[0])).not.toContain("web_search");
  });

  test("its searches and sources are stored and come back with the conversation", async () => {
    const client = recording(searchBlocks("Acme Oyj tender offer price"));
    chat._setChatClient(client);
    const userId = await signUp();
    const id = await idOf(
      await chat.startTurn(userId, { message: "Price?", webSearch: true }, never),
    );
    chat._setChatClient(null);

    expect(toolNames(client.seen[0])).toContain("web_search");
    const rows = await chat.conversationMessages(userId, id);
    const stored = rows.find((row) => row.role === "search");
    expect(StoredSearchSchema.parse(JSON.parse(stored?.content ?? "null"))).toEqual({
      searches: [
        { id: "srvtoolu_1", query: "Acme Oyj tender offer price", personal: false, failed: null },
      ],
      sources: [SOURCE],
    });
  });

  test("a query with the owner's name is stored as personal", async () => {
    chat._setChatClient(recording(searchBlocks("Maija Meikäläinen osinko")));
    const userId = await signUp();
    const id = await withOwnerName("Maija Meikäläinen", async () =>
      idOf(await chat.startTurn(userId, { message: "Osinko?", webSearch: true }, never)),
    );
    chat._setChatClient(null);

    const rows = await chat.conversationMessages(userId, id);
    expect(rows.find((row) => row.role === "search")?.content).toContain('"personal":true');
  });

  test("the next turn's model does not read the search row", async () => {
    const client = recording(searchBlocks("Acme Oyj tender offer price"));
    chat._setChatClient(client);
    const userId = await signUp();
    const id = await idOf(
      await chat.startTurn(userId, { message: "Price?", webSearch: true }, never),
    );
    await idOf(await chat.startTurn(userId, { conversationId: id, message: "Thanks" }, never));
    chat._setChatClient(null);

    expect(JSON.stringify(client.seen[1]?.messages)).not.toContain("tender offer price");
  });

  test("a conversation stored before search existed, or with an unreadable search row, still loads", async () => {
    chat._setChatClient(recording());
    const userId = await signUp();
    const id = await idOf(await chat.startTurn(userId, { message: "Price?" }, never));
    await db
      .insert(chatMessages)
      .values({ conversationId: id, role: "search", content: "{" })
      .run();
    await idOf(await chat.startTurn(userId, { conversationId: id, message: "Again" }, never));
    chat._setChatClient(null);

    const rows = await chat.conversationMessages(userId, id);
    expect(rows.map((row) => row.role)).toEqual([
      "user",
      "assistant",
      "search",
      "user",
      "assistant",
    ]);
  });
});
