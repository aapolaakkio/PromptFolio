import { beforeAll, describe, expect, test, vi } from "vitest";
import { z, ZodError } from "zod";

import { HttpError } from "../errors.ts";

// Chat is read-only, but it reads the ledger -- so these tests care most about
// who is allowed to read what. The model itself is scripted (see runner.test.ts
// for why): no key, no network, no cost.

type ChatClient = ReturnType<(typeof import("./runner.ts"))["createClient"]>;

type Conversations = typeof import("./conversations.ts");

let auth: ReturnType<(typeof import("../auth.ts"))["getAuth"]>;
let chat: Conversations;
let setChatClient: Conversations["_setChatClient"];

beforeAll(async () => {
  auth = (await import("../auth.ts")).getAuth();
  chat = await import("./conversations.ts");
  setChatClient = chat._setChatClient;
});

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
  // SAFETY: a 200 from POST /sign-up/email is Better Auth's documented success
  // response, which always carries `{ token, user: { id, ... } }`.
  const body = (await response.json()) as { user: { id: string } };
  return body.user.id;
};

/** One reply with no tool calls: the model answering in words. */
const assistantSaying = (text: string) => ({ text, toolCalls: [] });

/** Replies with one fixed sentence, whatever it is asked. */
const scriptedClient = (text = "Salkun arvo on 120,00 EUR."): ChatClient => ({
  run: () => Promise.resolve(assistantSaying(text)),
});

/** Fails the way the binding does when the service refuses: the call rejects. */
const failingClient = (): ChatClient => ({
  run: () => Promise.reject(new Error("api key rejected by https://internal.example/v1")),
});

type AskBody = Parameters<Conversations["startTurn"]>[1];

const never = new AbortController().signal;

const turn = (userId: string, body: AskBody, signal: AbortSignal = never) =>
  chat.startTurn(userId, body, signal);

/** The server's own event shapes, parsed rather than cast -- same rule the browser follows. */
const ChatEventSchema = z.union([
  z.object({ type: z.literal("conversation"), id: z.number() }),
  z.object({ type: z.literal("tool"), name: z.string() }),
  z.object({ type: z.literal("answer"), text: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
type StreamedEvent = z.infer<typeof ChatEventSchema>;

const eventsOf = async (stream: ReadableStream<Uint8Array>): Promise<StreamedEvent[]> => {
  const body = await new Response(stream).text();
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

const statusOf = async <T>(run: () => Promise<T>): Promise<number> => {
  try {
    await run();
  } catch (cause) {
    if (cause instanceof HttpError) return cause.status;
    if (cause instanceof ZodError) return 400;
    throw cause;
  }
  throw new Error("Expected the turn to be refused");
};

describe("startTurn", () => {
  test("refuses an empty question rather than paying for an empty turn", async () => {
    setChatClient(scriptedClient());
    const userId = await signUp();
    expect(await statusOf(() => turn(userId, { message: "   " }))).toBe(400);
  });

  test("streams the conversation id and the answer, and stores both turns", async () => {
    setChatClient(scriptedClient());
    const userId = await signUp();

    const events = await eventsOf(await turn(userId, { message: "Paljonko salkku on arvoltaan?" }));

    expect(events[0]?.type).toBe("conversation");
    expect(events.at(-1)).toEqual({ type: "answer", text: "Salkun arvo on 120,00 EUR." });

    expect(await chat.conversationMessages(userId, conversationIdOf(events))).toEqual([
      { role: "user", content: "Paljonko salkku on arvoltaan?" },
      { role: "assistant", content: "Salkun arvo on 120,00 EUR." },
    ]);
  });

  test("keeps a failed turn's question, and tells the browser without leaking the cause", async () => {
    setChatClient(failingClient());
    const userId = await signUp();

    const events = await eventsOf(await turn(userId, { message: "Mikä on tuotto?" }));

    expect(events.at(-1)).toEqual({ type: "error", message: "Vastauksen haku epäonnistui" });
    expect(await chat.conversationMessages(userId, conversationIdOf(events))).toEqual([
      { role: "user", content: "Mikä on tuotto?" },
    ]);
  });

  test("continues an existing conversation and refuses someone else's, as 404", async () => {
    setChatClient(scriptedClient("Jatkoa."));
    const owner = await signUp();
    const stranger = await signUp();

    const id = conversationIdOf(
      await eventsOf(await turn(owner, { message: "Ensimmäinen kysymys" })),
    );

    const again = await eventsOf(
      await turn(owner, { conversationId: id, message: "Entä toinen?" }),
    );
    expect(again[0]).toEqual({ type: "conversation", id });

    expect(await statusOf(() => turn(stranger, { conversationId: id, message: "Näytä" }))).toBe(
      404,
    );
  });
});

describe("choosing a model", () => {
  test("the picked model answers the turn, and one not on the list is refused", async () => {
    let asked: string | null = null;
    setChatClient({
      run: (params) => {
        asked = params.model;
        return Promise.resolve(assistantSaying("ok"));
      },
    });
    const userId = await signUp();

    await eventsOf(await turn(userId, { message: "moi", model: "@cf/openai/gpt-oss-20b" }));
    expect(asked).toBe("@cf/openai/gpt-oss-20b");

    // The server function validates with the same schema before startTurn runs.
    expect(chat.Ask.safeParse({ message: "moi", model: "@cf/evil/model" }).success).toBe(false);
  });
});

describe("a client that goes away mid-turn", () => {
  test("stops the model loop and reports nothing, instead of throwing into the log", async () => {
    // Counts how far the loop got: an aborted turn must stop asking the model,
    // not run the tool loop to the end and discard the result.
    let pulled = 0;
    setChatClient({
      run: (_params, options) => {
        expect(options?.signal).toBeDefined();
        pulled += 1;
        return Promise.resolve({
          text: "",
          toolCalls: [{ id: "c", name: "get_holdings", arguments: "{}" }],
        });
      },
    });
    const userId = await signUp();

    const abort = new AbortController();
    abort.abort();
    const events = await eventsOf(await turn(userId, { message: "Pitkä kysymys" }, abort.signal));

    expect(pulled).toBe(1);
    // No error event: the user leaving is not a failure to report.
    expect(events.some((event) => event.type === "error")).toBe(false);
    // ...and no answer stored, because none was received.
    const stored = await chat.conversationMessages(userId, conversationIdOf(events));
    expect(stored.map((m) => m.role)).toEqual(["user"]);
  });
});

describe("a client that closes the stream", () => {
  test("keeps serving the turn to the end, storing the answer it can no longer send", async () => {
    setChatClient(scriptedClient("Vastaus jota kukaan ei lue."));
    const userId = await signUp();

    const stream = await turn(userId, { message: "Suljetaan kesken" });
    // What a browser navigating away does: stop reading and cancel the body.
    // Enqueueing into that closed stream must not surface as a failed turn.
    await stream.cancel();

    const id = (await chat.listConversations(userId))[0]?.id;
    expect(id).toBeDefined();
    if (id === undefined) return;
    // Waited for, not read: the turn outlives the reader, so the answer lands
    // after the cancel rather than before it.
    await vi.waitFor(async () =>
      expect((await chat.conversationMessages(userId, id)).map((m) => m.role)).toEqual([
        "user",
        "assistant",
      ]),
    );
  });
});

describe("listConversations", () => {
  test("lists only the caller's own threads, newest first", async () => {
    setChatClient(scriptedClient());
    const mine = await signUp();
    const other = await signUp();
    await eventsOf(await turn(mine, { message: "Vanhempi kysymys" }));
    await eventsOf(await turn(mine, { message: "Uudempi kysymys" }));
    await eventsOf(await turn(other, { message: "Jonkun muun kysymys" }));

    expect((await chat.listConversations(mine)).map((c) => c.title)).toEqual([
      "Uudempi kysymys",
      "Vanhempi kysymys",
    ]);
  });
});

describe("deleteConversation", () => {
  test("removes the thread and its messages, and refuses someone else's", async () => {
    setChatClient(scriptedClient());
    const owner = await signUp();
    const stranger = await signUp();
    const id = conversationIdOf(await eventsOf(await turn(owner, { message: "Poistettava" })));

    expect(await statusOf(() => chat.deleteConversation(stranger, id))).toBe(404);

    await chat.deleteConversation(owner, id);
    expect(await statusOf(() => chat.conversationMessages(owner, id))).toBe(404);
  });
});
