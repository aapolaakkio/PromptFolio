import { describe, expect, test } from "vitest";

import { renderItems } from "./chat-order.ts";

const user = (content: string) => ({ role: "user" as const, content });
const text = (content: string) => ({ role: "assistant" as const, content });
const proposal = (content: string) => ({ role: "proposal" as const, content });
const chart = (content: string) => ({ role: "chart" as const, content });

describe("renderItems", () => {
  test("a turn's text comes first, as one block, and its cards follow in arrival order", () => {
    expect(renderItems([proposal("p"), text("a"), text("b")])).toEqual([
      { kind: "text", key: "text-0", content: "a\n\nb" },
      { kind: "card", key: "card-0", turn: proposal("p") },
    ]);
  });

  test("a stored conversation reads the same: each question, its answer, then its cards", () => {
    const items = renderItems([
      user("q1"),
      proposal("p1"),
      chart("c1"),
      text("a1"),
      user("q2"),
      chart("c2"),
      text("a2"),
    ]);
    expect(items.map((item) => (item.kind === "card" ? item.turn.content : item.content))).toEqual([
      "q1",
      "a1",
      "p1",
      "c1",
      "q2",
      "a2",
      "c2",
    ]);
  });

  test("a card that arrives while the text streams keeps its place below the text", () => {
    const before = renderItems([user("q"), text("Look"), proposal("p")]);
    const after = renderItems([user("q"), text("Looking at it now"), proposal("p")]);
    expect(before.map((item) => item.key)).toEqual(after.map((item) => item.key));
    expect(after.at(-1)).toMatchObject({ kind: "card" });
  });
});
