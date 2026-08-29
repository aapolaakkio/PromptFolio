import { beforeAll, describe, expect, test } from "bun:test";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta";
import { z } from "zod";

// Chat is read-only, but it reads the ledger -- so these tests care most about
// who is allowed to read what. The model itself is scripted (see runner.test.ts
// for why): no key, no network, no cost.

type ToolRunnerClient = (typeof import("../chat/runner"))["createClient"] extends (
  apiKey: string,
) => infer C
  ? C
  : never;

let auth: (typeof import("../auth"))["auth"];
let chatRoutes: (typeof import("./chat"))["chatRoutes"];
let setChatClient: (typeof import("./chat"))["_setChatClient"];

beforeAll(async () => {
  auth = (await import("../auth")).auth;
  const chat = await import("./chat");
  chatRoutes = chat.chatRoutes;
  setChatClient = chat._setChatClient;
});

const sessionCookieFrom = (response: Response): string => {
  const setCookie = response.headers.getSetCookie().find((c) => c.includes("session_token"));
  if (!setCookie) throw new Error("Response carried no session_token cookie");
  const nameValue = setCookie.split(";")[0];
  if (!nameValue) throw new Error("Malformed Set-Cookie header");
  return nameValue;
};

const signUp = async (): Promise<string> => {
  const response = await auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: `chat-api-${crypto.randomUUID()}@example.com`,
        password: "correct horse battery staple",
      }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed with status ${response.status}`);
  return sessionCookieFrom(response);
};

/**
 * The one field of a `BetaMessage` this route reads is `content`; the rest are
 * the API's own constants, filled in so the fake is a real message rather than
 * a cast. Shared with runner.test.ts's reasoning -- see that file.
 */
const assistantSaying = (text: string): BetaMessage => ({
  id: "msg_test",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content: [{ type: "text", text, citations: null }],
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

/** Replies with one fixed sentence, whatever it is asked. */
const scriptedClient = (text = "Salkun arvo on 120,00 EUR."): ToolRunnerClient => ({
  beta: {
    messages: {
      toolRunner: () => ({
        async *[Symbol.asyncIterator]() {
          yield assistantSaying(text);
        },
      }),
    },
  },
});

/** Fails the way the SDK does when the key is refused: mid-iteration. */
const failingClient = (): ToolRunnerClient => ({
  beta: {
    messages: {
      toolRunner: () => ({
        // oxlint-disable-next-line require-yield -- the point is that it throws
        async *[Symbol.asyncIterator](): AsyncGenerator<BetaMessage> {
          throw new Error("api key rejected by https://internal.example/v1");
        },
      }),
    },
  },
});

type AskBody = { message: string; conversationId?: number };

const ask = (cookie: string, body: AskBody): Promise<Response> =>
  chatRoutes["/api/chat"].POST(
    new Request("http://x/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  );

/** The server's own event shapes, parsed rather than cast -- same rule the browser follows. */
const ChatEventSchema = z.union([
  z.object({ type: z.literal("conversation"), id: z.number() }),
  z.object({ type: z.literal("tool"), name: z.string() }),
  z.object({ type: z.literal("answer"), text: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
type StreamedEvent = z.infer<typeof ChatEventSchema>;

const eventsOf = async (response: Response): Promise<StreamedEvent[]> => {
  const body = await response.text();
  return body
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => ChatEventSchema.parse(JSON.parse(chunk.slice("data: ".length))));
};

/** The id the server assigned, from the first event of a turn. */
const conversationIdOf = (events: readonly StreamedEvent[]): number => {
  const first = events[0];
  if (first?.type !== "conversation") throw new Error("First event did not name the conversation");
  return first.id;
};

const MessagesSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
});

const messagesOf = async (cookie: string, id: number) => {
  const response = await chatRoutes["/api/chat/conversations/:id"].GET(
    new Request(`http://x/api/chat/conversations/${id}`, { headers: { cookie } }),
  );
  return MessagesSchema.parse(await response.json()).messages;
};

describe("POST /api/chat", () => {
  test("rejects a request with no session", async () => {
    setChatClient(scriptedClient());
    const response = await ask("", { message: "moi" });
    expect(response.status).toBe(401);
  });

  test("refuses an empty question rather than paying for an empty turn", async () => {
    setChatClient(scriptedClient());
    const cookie = await signUp();
    const response = await ask(cookie, { message: "   " });
    expect(response.status).toBe(400);
  });

  test("streams the conversation id and the answer, and stores both turns", async () => {
    setChatClient(scriptedClient());
    const cookie = await signUp();

    const response = await ask(cookie, { message: "Paljonko salkku on arvoltaan?" });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const events = await eventsOf(response);

    expect(events[0]?.type).toBe("conversation");
    expect(events.at(-1)).toEqual({ type: "answer", text: "Salkun arvo on 120,00 EUR." });

    expect(await messagesOf(cookie, conversationIdOf(events))).toEqual([
      { role: "user", content: "Paljonko salkku on arvoltaan?" },
      { role: "assistant", content: "Salkun arvo on 120,00 EUR." },
    ]);
  });

  test("keeps a failed turn's question, and tells the browser without leaking the cause", async () => {
    setChatClient(failingClient());
    const cookie = await signUp();

    const events = await eventsOf(await ask(cookie, { message: "Mikä on tuotto?" }));

    expect(events.at(-1)).toEqual({ type: "error", message: "Vastauksen haku epäonnistui" });
    expect(await messagesOf(cookie, conversationIdOf(events))).toEqual([
      { role: "user", content: "Mikä on tuotto?" },
    ]);
  });

  test("continues an existing conversation and refuses someone else's, as 404", async () => {
    setChatClient(scriptedClient("Jatkoa."));
    const owner = await signUp();
    const stranger = await signUp();

    const id = conversationIdOf(
      await eventsOf(await ask(owner, { message: "Ensimmäinen kysymys" })),
    );

    const again = await eventsOf(await ask(owner, { conversationId: id, message: "Entä toinen?" }));
    expect(again[0]).toEqual({ type: "conversation", id });

    const intruder = await ask(stranger, { conversationId: id, message: "Näytä" });
    expect(intruder.status).toBe(404);
  });
});

describe("configuration", () => {
  test("answers 503 when the instance has no API key, instead of failing mid-stream", async () => {
    setChatClient(null);
    const previous = Bun.env.ANTHROPIC_API_KEY;
    delete Bun.env.ANTHROPIC_API_KEY;
    try {
      const cookie = await signUp();
      const response = await ask(cookie, { message: "moi" });
      expect(response.status).toBe(503);
    } finally {
      if (previous !== undefined) Bun.env.ANTHROPIC_API_KEY = previous;
    }
  });
});

describe("GET /api/chat/conversations", () => {
  test("lists only the caller's own threads, newest first", async () => {
    setChatClient(scriptedClient());
    const mine = await signUp();
    const other = await signUp();
    await ask(mine, { message: "Vanhempi kysymys" }).then(eventsOf);
    await ask(mine, { message: "Uudempi kysymys" }).then(eventsOf);
    await ask(other, { message: "Jonkun muun kysymys" }).then(eventsOf);

    const response = await chatRoutes["/api/chat/conversations"].GET(
      new Request("http://x/api/chat/conversations", { headers: { cookie: mine } }),
    );
    const body = z
      .object({ conversations: z.array(z.object({ title: z.string() })) })
      .parse(await response.json());

    expect(body.conversations.map((c) => c.title)).toEqual(["Uudempi kysymys", "Vanhempi kysymys"]);
  });

  test("rejects a request with no session", async () => {
    const response = await chatRoutes["/api/chat/conversations"].GET(
      new Request("http://x/api/chat/conversations"),
    );
    expect(response.status).toBe(401);
  });
});

describe("DELETE /api/chat/conversations/:id", () => {
  test("removes the thread and its messages, and refuses someone else's", async () => {
    setChatClient(scriptedClient());
    const owner = await signUp();
    const stranger = await signUp();
    const id = conversationIdOf(await eventsOf(await ask(owner, { message: "Poistettava" })));

    const refused = await chatRoutes["/api/chat/conversations/:id"].DELETE(
      new Request(`http://x/api/chat/conversations/${id}`, {
        method: "DELETE",
        headers: { cookie: stranger },
      }),
    );
    expect(refused.status).toBe(404);

    const deleted = await chatRoutes["/api/chat/conversations/:id"].DELETE(
      new Request(`http://x/api/chat/conversations/${id}`, {
        method: "DELETE",
        headers: { cookie: owner },
      }),
    );
    expect(deleted.status).toBe(200);

    const gone = await chatRoutes["/api/chat/conversations/:id"].GET(
      new Request(`http://x/api/chat/conversations/${id}`, { headers: { cookie: owner } }),
    );
    expect(gone.status).toBe(404);
  });
});
