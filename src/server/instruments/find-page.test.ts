import { describe, expect, test } from "vitest";

import { parseCurrency } from "../../core/money.ts";
import type { ChatClient, ModelReply, TurnParams } from "../chat/runner.ts";
import { webSearchFinder } from "./find-page.ts";

const EUR = parseCurrency("EUR");
const ISIN = "SE0005993102";

const scripted = (reply: ModelReply | Error): ChatClient & { asked: TurnParams[] } => {
  const asked: TurnParams[] = [];
  return {
    asked,
    run: async (params) => {
      asked.push(params);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
};

const text = (value: string): ModelReply => ({ text: value, toolCalls: [] });

describe("webSearchFinder", () => {
  test("one turn with the web search tool, capped, and the JSON reply read", async () => {
    const client = scripted(
      text(`{"url":"https://www.nordnet.fi/rahastot/suomi","isin":"${ISIN}"}`),
    );
    const found = await webSearchFinder(client)({
      isin: null,
      name: "Nordnet Suomi",
      currency: EUR,
    });

    expect(found).toEqual({ url: "https://www.nordnet.fi/rahastot/suomi", isin: ISIN });
    expect(client.asked).toHaveLength(1);
    expect(client.asked[0]?.tools).toEqual([
      { type: "web_search_20260318", name: "web_search", max_uses: 5 },
    ]);
    const user = client.asked[0]?.messages.find((m) => m.role === "user");
    expect(user?.content).toContain("Nordnet Suomi");
  });

  test("prose around the JSON is ignored", async () => {
    const client = scripted(
      text(`Löysin sivun.\n{"url":"https://example.fi/rahasto","isin":null}\nKiitos.`),
    );
    expect(await webSearchFinder(client)({ isin: ISIN, name: "X", currency: EUR })).toEqual({
      url: "https://example.fi/rahasto",
      isin: null,
    });
  });

  test("no page found is null", async () => {
    const client = scripted(text(`{"url":null,"isin":null}`));
    expect(await webSearchFinder(client)({ isin: ISIN, name: "X", currency: EUR })).toBeNull();
  });

  test("a reply that is not the JSON asked for is null", async () => {
    const client = scripted(text("En löytänyt mitään."));
    expect(await webSearchFinder(client)({ isin: ISIN, name: "X", currency: null })).toBeNull();
  });

  test("a URL that is not https is not used", async () => {
    const client = scripted(text(`{"url":"http://10.0.0.1/admin","isin":null}`));
    expect(await webSearchFinder(client)({ isin: ISIN, name: "X", currency: EUR })).toBeNull();
  });

  test("a malformed ISIN is dropped but the URL kept", async () => {
    const client = scripted(text(`{"url":"https://example.fi/r","isin":"nope"}`));
    expect(await webSearchFinder(client)({ isin: null, name: "X", currency: EUR })).toEqual({
      url: "https://example.fi/r",
      isin: null,
    });
  });

  test("a thrown model error propagates", async () => {
    const client = scripted(new Error("malli alhaalla"));
    await expect(webSearchFinder(client)({ isin: ISIN, name: "X", currency: EUR })).rejects.toThrow(
      "malli alhaalla",
    );
  });
});
