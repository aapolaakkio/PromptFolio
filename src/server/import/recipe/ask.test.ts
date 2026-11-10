import { expect, test } from "vitest";
import { z } from "zod";

import type { ChatClient, TurnParams } from "../../chat/runner.ts";
import { askForRecipe } from "./ask.ts";

test("the sample and the feedback reach the model without account numbers", async () => {
  const asked: TurnParams[] = [];
  const client: ChatClient = {
    run: async (params) => {
      asked.push(params);
      return { text: "{}", toolCalls: [] };
    },
  };

  await askForRecipe({
    client,
    instructions: "Read the file.",
    sample: "Date;Account;Amount\n03.11.2026;FI21 1234 5600 0007 85;-12,50",
    schema: z.object({}),
    run: () => null,
    judge: () => ({ passed: false, score: 0, feedback: "Row 1 unread: 1234567-8 Matti" }),
  });

  const sent = JSON.stringify(asked.map((params) => params.messages));
  expect(sent).not.toContain("1234 5600");
  expect(sent).not.toContain("1234567-8");
  expect(sent).toContain("03.11.2026;xx00 0000 0000 0000 00;-12,50");
  expect(sent).toContain("0000000-0 Matti");
  expect(asked[0]?.messages[0]?.content).toContain("Never match a literal 0 or x");
});
