import { describe, expect, test } from "vitest";

import { askChat, takeEvents } from "./chat-stream.ts";

describe("takeEvents", () => {
  test("returns whole events and keeps the unfinished tail", () => {
    const { events, rest } = takeEvents(
      'data: {"type":"tool","name":"get_holdings"}\n\ndata: {"type":"answ',
    );
    expect(events).toEqual([{ type: "tool", name: "get_holdings" }]);
    expect(rest).toBe('data: {"type":"answ');
  });

  test("drops an event shape the client does not know instead of rendering it", () => {
    const { events } = takeEvents('data: {"type":"prophecy","text":"buy"}\n\n');
    expect(events).toEqual([]);
  });

  test("keeps a proposal card whose input fits the action's own schema, and drops one that does not", () => {
    const card = {
      proposalId: "p-1",
      action: "cash_entry",
      summary: "Record a withdrawal of 250.00 EUR from Nordnet on 2026-11-03.",
      input: { accountId: 3, type: "WITHDRAWAL", tradeDate: "2026-11-03", amount: "250" },
    };
    const bad = { ...card, input: { ...card.input, amount: "-250" } };
    const { events } = takeEvents(
      `data: ${JSON.stringify({ type: "proposal", proposal: card })}\n\n` +
        `data: ${JSON.stringify({ type: "proposal", proposal: bad })}\n\n`,
    );
    expect(events).toEqual([
      { type: "proposal", proposal: { ...card, input: { ...card.input, currency: "EUR" } } },
    ]);
  });

  test("ignores keep-alive comments and blank frames", () => {
    const { events } = takeEvents(': keep-alive\n\ndata: {"type":"answer","text":"120.00"}\n\n');
    expect(events).toEqual([{ type: "answer", text: "120.00" }]);
  });
});

const streamOf = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
};

const collect = async (events: AsyncGenerator<unknown>): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
  return out;
};

describe("askChat", () => {
  test("yields events across chunk boundaries that split a single event", async () => {
    const fetchStub = async () =>
      new Response(
        streamOf([
          'data: {"type":"conv',
          'ersation","id":7}\n\n',
          'data: {"type":"answer","text":"120.00 EUR"}\n\n',
        ]),
        { headers: { "content-type": "text/event-stream" } },
      );

    expect(await collect(askChat({ message: "moi" }, fetchStub))).toEqual([
      { type: "conversation", id: 7 },
      { type: "answer", text: "120.00 EUR" },
    ]);
  });

  test("turns a refused request into one error event carrying the server's message", async () => {
    const fetchStub = async () =>
      Response.json(
        { error: "ANTHROPIC_API_KEY is missing from the server settings" },
        { status: 503 },
      );

    expect(await collect(askChat({ message: "moi" }, fetchStub))).toEqual([
      { type: "error", message: "ANTHROPIC_API_KEY is missing from the server settings" },
    ]);
  });

  test("falls back to a generic message when the failure body is unreadable", async () => {
    const fetchStub = async () => new Response("<html>502</html>", { status: 502 });

    expect(await collect(askChat({ message: "moi" }, fetchStub))).toEqual([
      { type: "error", message: "Could not fetch the answer" },
    ]);
  });
});
