import { beforeAll, describe, expect, test, vi } from "vitest";
import { z, ZodError } from "zod";

import { HttpError } from "../errors.ts";

// Chat reads the ledger, so these tests care most about who may read what. The model is scripted.

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
  // SAFETY: a 200 from POST /sign-up/email carries `{ token, user: { id } }`.
  const body = (await response.json()) as { user: { id: string } };
  return body.user.id;
};

const assistantSaying = (text: string) => ({ text, toolCalls: [] });

const scriptedClient = (text = "The portfolio is worth 120.00 EUR."): ChatClient => ({
  run: () => Promise.resolve(assistantSaying(text)),
});

const failingClient = (): ChatClient => ({
  run: () => Promise.reject(new Error("api key rejected by https://internal.example/v1")),
});

type AskBody = Parameters<Conversations["startTurn"]>[1];

const never = new AbortController().signal;

const turn = (userId: string, body: AskBody, signal: AbortSignal = never) =>
  chat.startTurn(userId, body, signal);

const ChatEventSchema = z.union([
  z.object({ type: z.literal("conversation"), id: z.number() }),
  z.object({ type: z.literal("tool"), name: z.string() }),
  z.object({ type: z.literal("delta"), text: z.string() }),
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

    const events = await eventsOf(await turn(userId, { message: "What is my portfolio worth?" }));

    expect(events[0]?.type).toBe("conversation");
    expect(events.at(-1)).toEqual({ type: "answer", text: "The portfolio is worth 120.00 EUR." });

    expect(await chat.conversationMessages(userId, conversationIdOf(events))).toEqual([
      { role: "user", content: "What is my portfolio worth?" },
      { role: "assistant", content: "The portfolio is worth 120.00 EUR." },
    ]);
  });

  test("keeps a failed turn's question, and tells the browser without leaking the cause", async () => {
    setChatClient(failingClient());
    const userId = await signUp();

    const events = await eventsOf(await turn(userId, { message: "What is the return?" }));

    expect(events.at(-1)).toEqual({ type: "error", message: "Fetching the answer failed" });
    expect(await chat.conversationMessages(userId, conversationIdOf(events))).toEqual([
      { role: "user", content: "What is the return?" },
    ]);
  });

  test("continues an existing conversation and refuses someone else's, as 404", async () => {
    setChatClient(scriptedClient("Jatkoa."));
    const owner = await signUp();
    const stranger = await signUp();

    const id = conversationIdOf(await eventsOf(await turn(owner, { message: "First question" })));

    const again = await eventsOf(
      await turn(owner, { conversationId: id, message: "And the second?" }),
    );
    expect(again[0]).toEqual({ type: "conversation", id });

    expect(await statusOf(() => turn(stranger, { conversationId: id, message: "Show" }))).toBe(404);
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

    await eventsOf(await turn(userId, { message: "hi", model: "claude-haiku-5-5" }));
    expect(asked).toBe("claude-haiku-5-5");

    expect(chat.Ask.safeParse({ message: "hi", model: "@cf/evil/model" }).success).toBe(false);
  });
});

describe("a client that goes away mid-turn", () => {
  test("stops the model loop and reports nothing, instead of throwing into the log", async () => {
    // An aborted turn must stop asking the model.
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
    const events = await eventsOf(await turn(userId, { message: "Long question" }, abort.signal));

    expect(pulled).toBe(1);
    expect(events.some((event) => event.type === "error")).toBe(false);
    const stored = await chat.conversationMessages(userId, conversationIdOf(events));
    expect(stored.map((m) => m.role)).toEqual(["user"]);
  });
});

describe("a client that closes the stream", () => {
  test("keeps serving the turn to the end, storing the answer it can no longer send", async () => {
    setChatClient(scriptedClient("An answer nobody reads."));
    const userId = await signUp();

    const stream = await turn(userId, { message: "Closed mid-stream" });
    // A browser navigating away cancels the body; enqueueing into it must not fail the turn.
    await stream.cancel();

    const id = (await chat.listConversations(userId))[0]?.id;
    expect(id).toBeDefined();
    if (id === undefined) return;
    // Waited for, not read: the turn outlives the reader.
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
    await eventsOf(await turn(mine, { message: "Older question" }));
    await eventsOf(await turn(mine, { message: "Newer question" }));
    await eventsOf(await turn(other, { message: "Someone else's question" }));

    expect((await chat.listConversations(mine)).map((c) => c.title)).toEqual([
      "Newer question",
      "Older question",
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

describe("proposals in a conversation", () => {
  const withAccount = async (): Promise<{ userId: string; accountId: number }> => {
    const userId = await signUp();
    const { CreateAccount, openAccount } = await import("../accounts.ts");
    const { db } = await import("../db/index.ts");
    const account = await openAccount(
      db,
      userId,
      CreateAccount.parse({ name: "Nordnet", broker: "nordnet" }),
    );
    return { userId, accountId: account.id };
  };

  const proposingClient = (accountId: number): ChatClient => {
    let round = 0;
    return {
      run: () => {
        round += 1;
        if (round === 1) {
          return Promise.resolve({
            text: "",
            toolCalls: [
              {
                id: "p1",
                name: "propose_cash_entry",
                arguments: JSON.stringify({
                  accountId,
                  type: "DEPOSIT",
                  tradeDate: "2026-11-01",
                  amount: "100",
                }),
              },
            ],
          });
        }
        return Promise.resolve(assistantSaying("Confirm the card to save it."));
      },
    };
  };

  const ProposalEvent = z.object({
    type: z.literal("proposal"),
    proposal: z
      .object({ proposalId: z.string(), summary: z.string(), title: z.string(), facts: z.json() })
      .loose(),
  });

  const proposalOf = async (stream: ReadableStream<Uint8Array>) => {
    const body = await new Response(stream).text();
    const events = body
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("data: "))
      .map((chunk) => z.json().parse(JSON.parse(chunk.slice("data: ".length))));
    const first = z.object({ type: z.literal("conversation"), id: z.number() }).parse(events[0]);
    const proposal = events.flatMap((event) => {
      const parsed = ProposalEvent.safeParse(event);
      return parsed.success ? [parsed.data.proposal] : [];
    })[0];
    if (proposal === undefined) throw new Error("No proposal streamed");
    return { conversationId: first.id, proposal };
  };

  test("stores the summary but never the input, so an old conversation cannot replay it", async () => {
    const { userId, accountId } = await withAccount();
    setChatClient(proposingClient(accountId));
    const { conversationId, proposal } = await proposalOf(
      await turn(userId, { message: "Record my deposit" }),
    );

    const stored = await chat.conversationMessages(userId, conversationId);
    expect(stored.map((m) => m.role)).toEqual(["user", "proposal", "assistant"]);
    const row = stored[1];
    expect(JSON.parse(row?.content ?? "")).toEqual({
      proposalId: proposal.proposalId,
      action: "cash_entry",
      summary: proposal.summary,
      title: proposal.title,
      facts: proposal.facts,
    });
  });

  test("the owner's outcome becomes a note the model reads next turn, once per proposal", async () => {
    const { userId, accountId } = await withAccount();
    const stranger = await signUp();
    setChatClient(proposingClient(accountId));
    const { conversationId, proposal } = await proposalOf(
      await turn(userId, { message: "Record my deposit" }),
    );
    const outcome = {
      conversationId,
      proposalId: proposal.proposalId,
      outcome: "saved" as const,
    };

    expect(await statusOf(() => chat.recordProposalOutcome(stranger, outcome))).toBe(404);
    await chat.recordProposalOutcome(userId, outcome);
    expect(await statusOf(() => chat.recordProposalOutcome(userId, outcome))).toBe(409);
    expect(
      await statusOf(() =>
        chat.recordProposalOutcome(userId, { ...outcome, proposalId: crypto.randomUUID() }),
      ),
    ).toBe(404);

    let sent: readonly { role: string; content: string }[] = [];
    setChatClient({
      run: (params) => {
        sent = params.messages.flatMap((m) =>
          m.role === "tool" ? [] : [{ role: m.role, content: m.content }],
        );
        return Promise.resolve(assistantSaying("Noted."));
      },
    });
    await eventsOf(await turn(userId, { conversationId, message: "Did it work?" }));

    const notes = sent.filter((m) => m.content.startsWith("[App note"));
    expect(notes.map((m) => m.role)).toEqual(["user", "user"]);
    expect(notes[1]?.content).toBe(
      `[App note, not written by the owner] The owner confirmed "${proposal.summary}" and it was saved.`,
    );
  });
});

describe("charts in a conversation", () => {
  const chartingClient = (): ChatClient => {
    let round = 0;
    return {
      run: () => {
        round += 1;
        if (round === 1) {
          return Promise.resolve({
            text: "",
            toolCalls: [
              {
                id: "c1",
                name: "show_chart",
                arguments: JSON.stringify({
                  title: "Allocation",
                  kind: "bar",
                  yUnit: "%",
                  series: [{ source: "allocation", dimension: "kind" }],
                  note: "Plain words.",
                }),
              },
            ],
          });
        }
        return Promise.resolve(assistantSaying("Here it is."));
      },
    };
  };

  test("a stored chart reloads with the conversation, and another user cannot load it", async () => {
    const userId = await signUp();
    const stranger = await signUp();
    const { ChatChartSchema } = await import("./chart-schema.ts");
    setChatClient(chartingClient());
    const body = await new Response(await turn(userId, { message: "Show my allocation" })).text();
    const events = body
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("data: "))
      .map((chunk) => z.json().parse(JSON.parse(chunk.slice("data: ".length))));
    const first = z.object({ type: z.literal("conversation"), id: z.number() }).parse(events[0]);
    const streamed = events.find(
      (event) =>
        z
          .object({ type: z.literal("chart") })
          .loose()
          .safeParse(event).success,
    );
    expect(streamed).toBeDefined();

    const stored = await chat.conversationMessages(userId, first.id);
    expect(stored.map((m) => m.role)).toEqual(["user", "chart", "assistant"]);
    const chart = ChatChartSchema.parse(JSON.parse(stored[1]?.content ?? ""));
    expect(chart.spec.note).toBe("Plain words.");
    expect(streamed).toEqual({ type: "chart", ...chart });

    expect(await statusOf(() => chat.conversationMessages(stranger, first.id))).toBe(404);
  });
});
