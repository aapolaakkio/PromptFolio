import { describe, expect, test } from "vitest";

import type { ChatClient, ModelReply, TurnParams } from "../../chat/runner.ts";
import { readText } from "../../files.ts";
import { generateRecipe, sampleFor } from "./generate.ts";
import { OP_STATEMENT_RECIPE } from "./op-reference.ts";
import type { BankRecipe } from "./types.ts";
import { VERIFY_TOOL_NAME } from "./verify-tool.ts";

const fixture = (): Promise<string> =>
  readText(`${import.meta.dirname}/../fixtures/op-statement-sample.txt`);

const pagesOf = (text: string) => [{ number: 1, text }];

const call = (recipe: Partial<BankRecipe>, text = ""): ModelReply => ({
  text,
  toolCalls: [{ id: "call_0", name: VERIFY_TOOL_NAME, arguments: JSON.stringify({ recipe }) }],
});

const stub = (...replies: ModelReply[]): ChatClient & { asked: TurnParams[] } => {
  const asked: TurnParams[] = [];
  let at = 0;
  return {
    asked,
    run: async (params) => {
      asked.push(params);
      const reply = replies[at] ?? replies.at(-1) ?? { text: "", toolCalls: [] };
      at += 1;
      return reply;
    },
  };
};

const good = OP_STATEMENT_RECIPE;
const wrongSign: BankRecipe = {
  ...OP_STATEMENT_RECIPE,
  money: { ...OP_STATEMENT_RECIPE.money, negative: "suffix" },
};

const noBalances: BankRecipe = {
  ...OP_STATEMENT_RECIPE,
  header: {
    ...OP_STATEMENT_RECIPE.header,
    openingBalance: String.raw`^EI-SALDOA (?<value>\d+,\d{2})$`,
    closingBalance: String.raw`^EI-SALDOA (?<value>\d+,\d{2})$`,
  },
};

const toolResults = (params: TurnParams | undefined): string[] =>
  (params?.messages ?? []).filter((m) => m.role === "tool").map((m) => m.content);

describe("sampleFor", () => {
  test("sends the first page whole and the end of the last", () => {
    const sample = sampleFor([
      { number: 1, text: "first page" },
      { number: 2, text: "middle" },
      { number: 3, text: "last page\nLOPPUSALDO 1,00" },
    ]);

    expect(sample).toContain("first page");
    expect(sample).toContain("LOPPUSALDO 1,00");
    expect(sample).not.toContain("middle");
  });

  test("sends the last page's end, not its beginning", () => {
    const last = ["OTSIKKO", ...Array.from({ length: 40 }, (_, at) => `middle ${at}`), "SALDO"];
    const sample = sampleFor([
      { number: 1, text: "first page" },
      { number: 2, text: last.join("\n") },
    ]);

    expect(sample).toContain("SALDO");
    expect(sample).not.toContain("middle 5");
  });

  test("does not repeat a single page", () => {
    const sample = sampleFor([{ number: 1, text: "ainoa" }]);
    expect(sample.match(/ainoa/g)).toHaveLength(1);
  });
});

describe("generateRecipe", () => {
  test("stops at the first candidate that verifies", async () => {
    const text = await fixture();
    const client = stub(call(good));

    const result = await generateRecipe(text, pagesOf(text), client);

    expect(result.verified).toBe(true);
    expect(client.asked).toHaveLength(1);
    expect(result.run.statement.rows.length).toBeGreaterThan(0);
  });

  test("converges: the model reads the complaint and fixes the recipe", async () => {
    const text = await fixture();
    const client = stub(call(wrongSign), call(good));

    const result = await generateRecipe(text, pagesOf(text), client);

    expect(result.verified).toBe(true);
    expect(result.recipe).toEqual(good);
    expect(client.asked).toHaveLength(2);
    expect(toolResults(client.asked[1])[0]).toMatch(/Balance check/);
  });

  test("returns the recipe that verified, not the last one the model mentioned", async () => {
    const text = await fixture();
    const client = stub(call(good, JSON.stringify(wrongSign)));

    const result = await generateRecipe(text, pagesOf(text), client);

    expect(result.recipe.money.negative).toBe("leading");
  });

  test("gives back the best attempt as an unverified draft when nothing verifies", async () => {
    const text = await fixture();
    const client = stub(call(wrongSign));

    const result = await generateRecipe(text, pagesOf(text), client);

    expect(result.verified).toBe(false);
    expect(result.run.statement.rows.length).toBeGreaterThan(0);
    expect(client.asked.length).toBeLessThanOrEqual(10);
  });

  test("hands a schema-invalid candidate back as a tool result and carries on", async () => {
    const text = await fixture();
    const client = stub(call({ kind: "bank" }), call(good));

    const result = await generateRecipe(text, pagesOf(text), client);

    expect(result.verified).toBe(true);
    expect(toolResults(client.asked[1])[0]).toContain("not valid");
  });

  test("hands a recipe that cannot find the balances back as a tool result", async () => {
    const text = await fixture();
    const client = stub(call(noBalances), call(good));

    const result = await generateRecipe(text, pagesOf(text), client);

    expect(result.verified).toBe(true);
    expect(toolResults(client.asked[1])[0]).toMatch(/balance/i);
  });

  test("refuses when the model never calls the tool", async () => {
    const text = await fixture();
    const client = stub({ text: JSON.stringify(good), toolCalls: [] });

    await expect(generateRecipe(text, pagesOf(text), client)).rejects.toThrow();
  });

  test("shows the model the worked example and the tool", async () => {
    const text = await fixture();
    const client = stub(call(good));
    await generateRecipe(text, pagesOf(text), client);

    const first = client.asked[0];
    expect(first?.messages[0]?.content).toContain("recordStart");
    expect(first?.tools[0]?.name).toBe(VERIFY_TOOL_NAME);
  });
});

describe("what each round resends", () => {
  test("keeps the prompt flat instead of carrying every earlier attempt", async () => {
    const client = stub(call(wrongSign));
    await generateRecipe(await fixture(), pagesOf(await fixture()), client);

    expect(client.asked).toHaveLength(10);
    const sizes = client.asked.map((params) => params.messages.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(6);
  });

  test("carries the attempt just made, so the model sees what it broke", async () => {
    const client = stub(call(wrongSign));
    await generateRecipe(await fixture(), pagesOf(await fixture()), client);

    expect(toolResults(client.asked.at(-1))).not.toHaveLength(0);
    expect(toolResults(client.asked.at(-1)).at(-1)).toMatch(/Balance check/);
  });

  test("never drops the tool result belonging to an assistant's call", async () => {
    const client = stub(call(wrongSign));
    await generateRecipe(await fixture(), pagesOf(await fixture()), client);

    for (const params of client.asked) {
      const calls = params.messages.flatMap((m) =>
        m.role === "assistant" ? (m.tool_calls ?? []) : [],
      );
      const answered = new Set(
        params.messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])),
      );
      for (const one of calls) expect(answered.has(one.id)).toBe(true);
    }
  });
});

describe("what the model is shown", () => {
  test("an account number and a personal identity code never leave, in the sample or a tool result", async () => {
    const text = `${await fixture()}\nTILI FI21 1234 5600 0007 85 MATTI 010190-123A`;
    const client = stub(call(wrongSign), call(good));

    await generateRecipe(text, pagesOf(text), client);

    const sent = JSON.stringify(client.asked.map((params) => params.messages));
    expect(sent).not.toContain("1234 5600");
    expect(sent).not.toContain("010190");
    expect(sent).toContain("xx00 0000 0000 0000 00");
    expect(client.asked[0]?.messages[0]?.content).toContain("Never match a literal 0 or x");
  });
});
