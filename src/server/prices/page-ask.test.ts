import { describe, expect, test } from "vitest";

import { parseCurrency } from "../../core/money.ts";
import type { ChatClient, ModelReply, TurnParams } from "../chat/runner.ts";
import { readText } from "../files.ts";
import { pageSample, writePageRecipe } from "./page-ask.ts";
import type { PageExpect, PageRecipe } from "./page-recipe.ts";

const ISIN = "SE0005993102";
const EUR = parseCurrency("EUR");

const GOOD: PageRecipe = {
  kind: "page",
  pattern:
    String.raw`\\"currency\\":\\"(?<currency>[A-Z]{3})\\"\}\},\\"navInfo\\":\{[^}]*?\\"latestNav\\":` +
    String.raw`\{\\"date\\":\\"(?<date>\d{4}-\d{2}-\d{2})\\",\\"value\\":(?<price>[\d.]+)\}`,
  dateFormat: "yyyy-mm-dd",
  money: { decimal: ".", thousands: "", negative: "leading", twoColumn: false },
  currency: null,
};
const BAD: PageRecipe = { ...GOOD, pattern: String.raw`(?<date>nope)(?<price>nope)` };

const expectation: PageExpect = {
  identity: ISIN,
  currency: EUR,
  referenceMinor: null,
  today: "2026-08-27",
};

const fixture = () => readText(`${import.meta.dirname}/fixtures/nordnet-fund-suomi.html`);
const reply = (recipe: PageRecipe): ModelReply => ({ text: JSON.stringify(recipe), toolCalls: [] });

const stub = (...replies: ModelReply[]): ChatClient & { asked: TurnParams[] } => {
  const asked: TurnParams[] = [];
  let at = 0;
  return {
    asked,
    run: async (params) => {
      asked.push(params);
      const next = replies[at] ?? replies.at(-1) ?? { text: "", toolCalls: [] };
      at += 1;
      return next;
    },
  };
};

describe("writePageRecipe", () => {
  test("a good first answer is returned with the price it read", async () => {
    const client = stub(reply(GOOD));
    const result = await writePageRecipe(await fixture(), expectation, client);

    expect(result).toEqual({
      recipe: GOOD,
      price: { date: "2026-08-25", closeMinor: 36525, currency: EUR },
    });
    expect(client.asked).toHaveLength(1);
  });

  test("a wrong first answer gets feedback and the second passes", async () => {
    const client = stub(reply(BAD), reply(GOOD));
    const result = await writePageRecipe(await fixture(), expectation, client);

    expect("recipe" in result).toBe(true);
    const last = client.asked[1]?.messages.at(-1);
    expect(last?.role).toBe("user");
    expect(last && "content" in last ? last.content : "").toContain(
      "The expression matched nothing on the page.",
    );
  });

  test("no passing answer returns the reason", async () => {
    const result = await writePageRecipe(await fixture(), expectation, stub(reply(BAD)));

    expect(result).toEqual({ error: "The expression matched nothing on the page." });
  });

  test("a reply that is not a recipe returns the reason", async () => {
    const result = await writePageRecipe(
      await fixture(),
      expectation,
      stub({ text: "I cannot tell", toolCalls: [] }),
    );

    expect("error" in result && result.error.length > 0).toBe(true);
  });
});

describe("pageSample", () => {
  test("the sample holds the text around the ISIN from deep in a large page", async () => {
    const page = `${"<p>x</p>".repeat(100_000)}${await fixture()}${"<p>y</p>".repeat(100_000)}`;
    const sample = pageSample(page, ISIN);

    expect(sample).toContain("navInfo");
    expect(sample.length).toBeLessThanOrEqual(40_000);
  });

  test("falls back to the start of the page when the identity is absent", () => {
    const sample = pageSample(`start${"z".repeat(60_000)}`, ISIN);

    expect(sample.startsWith("start")).toBe(true);
    expect(sample).toHaveLength(40_000);
  });
});
