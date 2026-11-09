import { expect, test } from "vitest";

import type { ChatClient, TurnParams } from "../chat/runner.ts";
import { askForSummary } from "./ask.ts";

const FACTS = JSON.stringify(
  { changeExcludingDepositsEur: "100.00", changeDirection: "up" },
  null,
  2,
);

const scripted = (texts: readonly string[]): ChatClient & { asked: TurnParams[] } => {
  const asked: TurnParams[] = [];
  return {
    asked,
    run: async (params) => {
      asked.push(params);
      const text = texts[Math.min(asked.length - 1, texts.length - 1)] ?? "";
      return { text: JSON.stringify({ text }), toolCalls: [] };
    },
  };
};

test("a rejected text is sent back with the reason, and the corrected one is used", async () => {
  const client = scripted([
    "Your portfolio is up 250.00 euros.",
    "Your portfolio is up 100.00 euros.",
  ]);
  expect(await askForSummary(client, FACTS)).toBe("Your portfolio is up 100.00 euros.");
  expect(client.asked).toHaveLength(2);
  const retry = client.asked[1]?.messages.at(-1);
  expect(retry?.role).toBe("user");
  expect(retry?.content).toContain("250");
});

test("three rejected texts give up", async () => {
  const client = scripted(["Up 999.00 euros."]);
  expect(await askForSummary(client, FACTS)).toBeNull();
  expect(client.asked).toHaveLength(3);
});
