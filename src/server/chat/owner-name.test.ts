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
  test("the name becomes x characters of the same length, in any case and either order", () => {
    const hidden = hidingOwnerName(
      params("Maksaja: VIRTANEN MATTI JUHANI", "Virtanen, Matti / matti.virtanen"),
      "Matti Virtanen",
    );

    expect(contentsOf(hidden).slice(1)).toEqual([
      "Maksaja: xxxxxxxx xxxxx JUHANI",
      "xxxxxxxx, xxxxx / xxxxx.xxxxxxxx",
    ]);
  });

  test("one part alone is left: it may be a company, a ticker or a plain word", () => {
    const turn = params(
      '{"name":"Sampo Oyj","ticker":"SAMPO","may":1}',
      "You may propose. Bo went to Li",
    );

    expect(contentsOf(hidingOwnerName(turn, "Sampo May")).slice(1)).toEqual(
      contentsOf(turn).slice(1),
    );
    expect(contentsOf(hidingOwnerName(turn, "Bo Li")).slice(1)).toEqual(contentsOf(turn).slice(1));
  });

  test("a single-word name is hidden as a whole word only", () => {
    const hidden = hidingOwnerName(params("Madonna paid Madonnas bill"), "Madonna");

    expect(contentsOf(hidden)[1]).toBe("xxxxxxx paid Madonnas bill");
  });

  test("the model is told, once, in the system message", () => {
    const hidden = hidingOwnerName(params("Matti"), "Matti Virtanen");

    expect(contentsOf(hidden)[0]).toMatch(/^Be brief\.\n\nPrivacy: the owner's own name/);
  });

  test("tool results keep their shape and an earlier answer is hidden too", () => {
    const turn: TurnParams = {
      ...params(),
      messages: [
        { role: "assistant", content: "Hello Åke Öst" },
        { role: "tool", tool_call_id: "c1", content: '{"payee":"Öst,Åke"}' },
      ],
    };

    expect(contentsOf(hidingOwnerName(turn, "Åke  Öst"))).toEqual([
      "Hello xxx xxx",
      '{"payee":"xxx,xxx"}',
    ]);
  });

  test("no name changes nothing", () => {
    const turn = params("Bo went to Li");

    expect(hidingOwnerName(turn, null)).toBe(turn);
    expect(hidingOwnerName(turn, " ")).toBe(turn);
  });

  test("a name with regex characters is matched literally", () => {
    const hidden = hidingOwnerName(params("O'Neil+co, Anne-Marie (A.M.)"), "Anne-Marie O'Neil+co");

    expect(contentsOf(hidden)[1]).toBe("x'xxxx+xx, xxxx-xxxxx (A.M.)");
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
