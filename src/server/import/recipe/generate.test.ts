import { describe, expect, test } from "vitest";

import { readText } from "../../files.ts";
import type { ChatClient } from "../../chat/runner.ts";
import { generateRecipe, sampleFor } from "./generate.ts";
import { OP_STATEMENT_RECIPE } from "./op-reference.ts";

const fixture = (): Promise<string> =>
  readText(`${import.meta.dirname}/../fixtures/op-statement-sample.txt`);

const pagesOf = (text: string) => [{ number: 1, text }];

/** Replies in order; records what it was asked. */
const stub = (...replies: string[]): ChatClient & { asked: string[] } => {
  const asked: string[] = [];
  let at = 0;
  const client: ChatClient & { asked: string[] } = {
    asked,
    run: async (params) => {
      asked.push(params.messages.map((m) => m.content).join("\n"));
      const reply = replies[at] ?? replies.at(-1) ?? "";
      at += 1;
      return { text: reply, toolCalls: [] };
    },
  };
  return client;
};

const good = JSON.stringify(OP_STATEMENT_RECIPE);
// "suffix" with no matching debit word drops the sign entirely, so the
// negative rows vanish from the balance sum -- a real, detectable failure.
const wrongSign = JSON.stringify({
  ...OP_STATEMENT_RECIPE,
  money: { ...OP_STATEMENT_RECIPE.money, negative: "suffix" },
});

/**
 * A recipe whose balance patterns match nothing: `runRecipe` throws instead of
 * failing verification, which is the single likeliest first-attempt mistake.
 */
const noBalances = JSON.stringify({
  ...OP_STATEMENT_RECIPE,
  header: {
    ...OP_STATEMENT_RECIPE.header,
    openingBalance: String.raw`^EI-SALDOA (?<value>\d+,\d{2})$`,
    closingBalance: String.raw`^EI-SALDOA (?<value>\d+,\d{2})$`,
  },
});

describe("sampleFor", () => {
  test("sends the first page whole and the tail of the last", () => {
    const sample = sampleFor([
      { number: 1, text: "eka sivu" },
      { number: 2, text: "keski" },
      { number: 3, text: "vika sivu" },
    ]);

    expect(sample).toContain("eka sivu");
    expect(sample).toContain("vika sivu");
    expect(sample).not.toContain("keski");
  });

  test("does not repeat a single page", () => {
    const sample = sampleFor([{ number: 1, text: "ainoa" }]);
    expect(sample.match(/ainoa/g)).toHaveLength(1);
  });
});

describe("generateRecipe", () => {
  test("returns a verified recipe from a good first answer", async () => {
    const text = await fixture();
    const client = stub(good);

    const result = await generateRecipe(text, pagesOf(text), client);

    expect(result.verified).toBe(true);
    expect(client.asked).toHaveLength(1);
  });

  test("retries once with the report when the first answer does not verify", async () => {
    const text = await fixture();
    const client = stub(wrongSign, good);

    const result = await generateRecipe(text, pagesOf(text), client);

    expect(result.verified).toBe(true);
    expect(client.asked).toHaveLength(2);
    expect(client.asked[1]).toMatch(/Saldotarkistus/);
  });

  test("gives back the unverified run when both answers fail", async () => {
    const text = await fixture();
    const client = stub(wrongSign, wrongSign);

    const result = await generateRecipe(text, pagesOf(text), client);

    expect(result.verified).toBe(false);
    expect(result.run.statement.rows.length).toBeGreaterThan(0);
  });

  test("accepts an answer wrapped in a fenced block", async () => {
    const text = await fixture();
    const client = stub("Tässä kuvaus:\n```json\n" + good + "\n```");

    expect((await generateRecipe(text, pagesOf(text), client)).verified).toBe(true);
  });

  test("prefers the fenced block over reasoning braces elsewhere in the reply", async () => {
    const text = await fixture();
    const reasoning = "Ajattelin näin: tarkistin muodon {tarkistus ok} ja päättelin...";
    const client = stub(`${reasoning}\n\`\`\`json\n${good}\n\`\`\``);

    expect((await generateRecipe(text, pagesOf(text), client)).verified).toBe(true);
  });

  test("accepts an answer that reasons first, braces and all, before the JSON", async () => {
    const text = await fixture();
    const reasoning = "Ajattelin näin: tarkistin muodon {tarkistus ok} ja päättelin...";
    const client = stub(`${reasoning}\n${good}`);

    expect((await generateRecipe(text, pagesOf(text), client)).verified).toBe(true);
  });

  test("accepts an answer whose recipe has a brace inside a string value", async () => {
    const text = await fixture();
    const withBraceInString = JSON.stringify({
      ...OP_STATEMENT_RECIPE,
      money: { ...OP_STATEMENT_RECIPE.money, strip: ["{EUR"] },
    });
    const client = stub(withBraceInString);

    expect((await generateRecipe(text, pagesOf(text), client)).verified).toBe(true);
  });

  test("refuses a reply that only reasons, braces and all, with no JSON answer", async () => {
    const text = await fixture();
    const reasoning = "Ajattelin näin: tarkistin muodon {tarkistus ok} ja en osaa vastata.";
    await expect(generateRecipe(text, pagesOf(text), stub(reasoning))).rejects.toThrow();
  });

  test("refuses a reply that holds no JSON at all", async () => {
    const text = await fixture();
    await expect(generateRecipe(text, pagesOf(text), stub("en osaa"))).rejects.toThrow();
  });

  test("refuses a reply whose JSON is not a recipe", async () => {
    const text = await fixture();
    await expect(generateRecipe(text, pagesOf(text), stub('{"kind":"bank"}'))).rejects.toThrow();
  });

  test("retries when the first recipe cannot even find the balances", async () => {
    const text = await fixture();
    const client = stub(noBalances, good);

    const result = await generateRecipe(text, pagesOf(text), client);

    expect(result.verified).toBe(true);
    expect(client.asked).toHaveLength(2);
    expect(client.asked[1]).toMatch(/saldo/i);
  });

  test("gives back the second reading when only the first one threw", async () => {
    const text = await fixture();
    const client = stub(noBalances, wrongSign);

    const result = await generateRecipe(text, pagesOf(text), client);

    expect(result.verified).toBe(false);
    expect(result.run.statement.rows.length).toBeGreaterThan(0);
  });

  test("gives up when both recipes throw: there is nothing to draft from", async () => {
    const text = await fixture();
    await expect(generateRecipe(text, pagesOf(text), stub(noBalances, noBalances))).rejects.toThrow(
      /saldo/i,
    );
  });

  test("shows the model the worked example", async () => {
    const text = await fixture();
    const client = stub(good);
    await generateRecipe(text, pagesOf(text), client);

    expect(client.asked[0]).toContain("recordStart");
  });
});
