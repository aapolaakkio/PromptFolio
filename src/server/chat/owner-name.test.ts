import { describe, expect, test } from "vitest";

import { hidingOwnerName, ownerNameNow, withOwnerName } from "./owner-name.ts";
import type { TurnParams } from "./runner.ts";

const params = (...contents: string[]): TurnParams => ({
  model: "m",
  max_tokens: 1,
  tools: [],
  messages: [
    { role: "system", content: "Be brief." },
    ...contents.map((content) => ({ role: "user" as const, content })),
  ],
});

const contentsOf = (turn: TurnParams): string[] => turn.messages.map((message) => message.content);

describe("hidingOwnerName", () => {
  test("every part of the name becomes x characters of the same length, in any case and order", () => {
    const hidden = hidingOwnerName(
      params("Maksaja: VIRTANEN MATTI JUHANI", "matti's savings, Virtanen"),
      "Matti Virtanen",
    );

    expect(contentsOf(hidden).slice(1)).toEqual([
      "Maksaja: xxxxxxxx xxxxx JUHANI",
      "xxxxx's savings, xxxxxxxx",
    ]);
  });

  test("the model is told, once, in the system message", () => {
    const hidden = hidingOwnerName(params("Matti"), "Matti Virtanen");

    expect(contentsOf(hidden)[0]).toMatch(/^Be brief\.\n\nPrivacy: the owner's own name/);
  });

  test("a name inside a longer word is left alone, and so is a tool result's shape", () => {
    const turn: TurnParams = {
      ...params("Mattila Oy, Virtasen"),
      messages: [
        { role: "user", content: "Mattila Oy, Virtasen" },
        { role: "tool", tool_call_id: "c1", content: '{"payee":"Åke Öst"}' },
      ],
    };

    expect(contentsOf(hidingOwnerName(turn, "Matti Virtanen"))[0]).toBe("Mattila Oy, Virtasen");
    expect(contentsOf(hidingOwnerName(turn, "Åke Öst"))[1]).toBe('{"payee":"xxx xxx"}');
  });

  test("no name, or one too short to be told from a word, changes nothing", () => {
    const turn = params("Bo went to Li");

    expect(hidingOwnerName(turn, null)).toBe(turn);
    expect(hidingOwnerName(turn, "Bo Li")).toBe(turn);
  });

  test("a name with regex characters is matched literally", () => {
    const hidden = hidingOwnerName(params("Anne-Marie (A.M.) O'Neil+co"), "Anne-Marie O'Neil+co");

    expect(contentsOf(hidden)[1]).toBe("xxxx-xxxxx (A.M.) x'xxxx+xx");
  });
});

describe("withOwnerName", () => {
  test("the name is known inside the request and nowhere else", async () => {
    expect(ownerNameNow()).toBeNull();
    const seen = await withOwnerName("Matti Virtanen", async () => {
      await Promise.resolve();
      return ownerNameNow();
    });
    expect(seen).toBe("Matti Virtanen");
    expect(ownerNameNow()).toBeNull();
  });
});
