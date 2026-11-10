import { describe, expect, test } from "vitest";

import { PRINT_ATTRIBUTE, PRINT_FOOTER_ATTRIBUTE, printChart } from "./export-print.ts";

const element = () => {
  const attributes = new Map<string, string>();
  return {
    attributes,
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
  };
};

const setup = (print?: () => void) => {
  const frame = element();
  const root = element();
  const listeners: (() => void)[] = [];
  const seen: Record<string, string | undefined>[] = [];
  const win = {
    addEventListener: (_type: "afterprint", listener: () => void) => void listeners.push(listener),
    print: () => {
      seen.push({
        frame: frame.attributes.get(PRINT_ATTRIBUTE),
        root: root.attributes.get(PRINT_ATTRIBUTE),
        footer: frame.attributes.get(PRINT_FOOTER_ATTRIBUTE),
      });
      print?.();
    },
  };
  return { frame, root, listeners, seen, win };
};

describe("printChart", () => {
  const today = new Date(2026, 10, 10);

  test("marks the frame and the page before the print dialog opens", () => {
    const { frame, root, seen, win } = setup();

    printChart(frame, { title: "Allocation", today, win, root });

    expect(seen).toEqual([
      { frame: "frame", root: "page", footer: "Allocation · PromptFolio · 2026-11-10" },
    ]);
  });

  test("keeps the marks until the browser says printing is over, then removes them", () => {
    const { frame, root, listeners, win } = setup();

    printChart(frame, { title: "Allocation", today, win, root });
    expect(frame.attributes.size).toBe(2);
    expect(root.attributes.size).toBe(1);

    listeners.forEach((listener) => listener());
    expect(frame.attributes.size).toBe(0);
    expect(root.attributes.size).toBe(0);
  });

  test("removes the marks when printing cannot start", () => {
    const { frame, root, win } = setup(() => {
      throw new Error("blocked");
    });

    expect(() => printChart(frame, { title: "Allocation", today, win, root })).toThrow("blocked");
    expect(frame.attributes.size).toBe(0);
    expect(root.attributes.size).toBe(0);
  });
});
