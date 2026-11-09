import { describe, expect, test } from "vitest";

import type { ChatClient, ModelReply, TurnParams } from "../chat/runner.ts";
import { MAX_SUGGESTED_ROWS, suggestRows, type SuggestProblem } from "./suggest-rows.ts";

const scripted = (text: string): ChatClient & { asked: TurnParams[] } => {
  const asked: TurnParams[] = [];
  return {
    asked,
    run: async (params): Promise<ModelReply> => {
      asked.push(params);
      return { text, toolCalls: [] };
    },
  };
};

const reply = (rows: readonly { line: number; fields: Record<string, string | null> }[]) =>
  JSON.stringify({ rows });

const BROKER_RAW = "12.03.2024 OSTO Nokia Oyj FI0009000681 100 kpl 3,85 EUR 1 234,50";
const broker: SuggestProblem = { line: 7, raw: BROKER_RAW, message: "Unknown type: OSTO" };

const blanks = {
  tradeDate: null,
  type: null,
  isin: null,
  quantityText: null,
  amountEur: null,
  feeEur: null,
  currency: null,
};

describe("suggestRows broker", () => {
  test("prefills date, type, isin, quantity, amount and currency read from the raw text", async () => {
    const client = scripted(
      reply([
        {
          line: 7,
          fields: {
            ...blanks,
            tradeDate: "2024-03-12",
            type: "BUY",
            isin: "FI0009000681",
            quantityText: "100",
            amountEur: "1234.50",
            currency: "EUR",
          },
        },
      ]),
    );
    const out = await suggestRows(client, "broker", [broker], []);
    expect(out.get(7)).toEqual({
      tradeDate: "2024-03-12",
      type: "BUY",
      isin: "FI0009000681",
      quantityText: "100",
      amountEur: "1234.50",
      currency: "EUR",
    });
  });

  test("drops an invented amount but keeps the other fields", async () => {
    const client = scripted(
      reply([
        {
          line: 7,
          fields: { ...blanks, tradeDate: "2024-03-12", quantityText: "100", amountEur: "999.99" },
        },
      ]),
    );
    const out = await suggestRows(client, "broker", [broker], []);
    expect(out.get(7)).toEqual({ tradeDate: "2024-03-12", quantityText: "100" });
  });

  test("drops a date that is not in the text, an unknown type and a foreign currency", async () => {
    const client = scripted(
      reply([
        {
          line: 7,
          fields: {
            ...blanks,
            tradeDate: "2024-03-13",
            type: "GIFT",
            currency: "USD",
            feeEur: "3.85",
          },
        },
      ]),
    );
    const out = await suggestRows(client, "broker", [broker], []);
    expect(out.get(7)).toEqual({ feeEur: "3.85" });
  });

  test("a suggestion for a line that was not asked about is ignored", async () => {
    const client = scripted(reply([{ line: 99, fields: { ...blanks, quantityText: "100" } }]));
    expect((await suggestRows(client, "broker", [broker], [])).size).toBe(0);
  });

  test("one call covers at most MAX_SUGGESTED_ROWS problems, the first ones", async () => {
    const many = Array.from({ length: MAX_SUGGESTED_ROWS + 5 }, (_, at) => ({
      line: at + 1,
      raw: `row ${at + 1}`,
      message: "bad",
    }));
    const client = scripted(reply([]));
    await suggestRows(client, "broker", many, []);
    expect(client.asked).toHaveLength(1);
    const prompt = client.asked[0]?.messages.map((m) => m.content).join("\n") ?? "";
    expect(prompt).toContain(`"line":${MAX_SUGGESTED_ROWS}`);
    expect(prompt).not.toContain(`"line":${MAX_SUGGESTED_ROWS + 1},`);
  });

  test("no problems means no model call", async () => {
    const client = scripted("{}");
    expect((await suggestRows(client, "broker", [], [])).size).toBe(0);
    expect(client.asked).toHaveLength(0);
  });

  test("a throwing model gives no suggestions and does not throw", async () => {
    const client: ChatClient = {
      run: async () => {
        throw new Error("down");
      },
    };
    expect((await suggestRows(client, "broker", [broker], [])).size).toBe(0);
  });

  test("a malformed reply gives no suggestions", async () => {
    expect((await suggestRows(scripted("not json"), "broker", [broker], [])).size).toBe(0);
  });

  test("the prompt carries the raw text, the recipe's message and the examples", async () => {
    const client = scripted(reply([]));
    await suggestRows(client, "broker", [broker], [{ tradeDate: "2024-01-02" }]);
    const prompt = client.asked[0]?.messages.map((m) => m.content).join("\n") ?? "";
    expect(prompt).toContain("Unknown type: OSTO");
    expect(prompt).toContain("FI0009000681");
    expect(prompt).toContain('"tradeDate":"2024-01-02"');
  });
});

describe("suggestRows bank", () => {
  const raw = "05.02.2024 Prisma Kamppi -45,60 viite 123";
  const problem: SuggestProblem = { line: 3, raw, message: "Unrecognised line" };

  test("prefills date, type, amount and counterparty; drops a counterparty not in the text", async () => {
    const ok = await suggestRows(
      scripted(
        reply([
          {
            line: 3,
            fields: {
              date: "2024-02-05",
              type: "WITHDRAWAL",
              amountEur: "-45.60",
              counterparty: "Prisma Kamppi",
            },
          },
        ]),
      ),
      "bank",
      [problem],
      [],
    );
    expect(ok.get(3)).toEqual({
      date: "2024-02-05",
      type: "WITHDRAWAL",
      amountEur: "-45.60",
      counterparty: "Prisma Kamppi",
    });
    const bad = await suggestRows(
      scripted(
        reply([
          {
            line: 3,
            fields: { date: null, type: null, amountEur: null, counterparty: "K-Market" },
          },
        ]),
      ),
      "bank",
      [problem],
      [],
    );
    expect(bad.size).toBe(0);
  });
});
