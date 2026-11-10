import { describe, expect, test } from "vitest";

import { PRINT_ATTRIBUTE, PRINT_FOOTER_ATTRIBUTE, printChart } from "./export-print.ts";

const element = (initial: Record<string, string> = {}) => {
  const attributes = new Map(Object.entries(initial));
  return {
    attributes,
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
  };
};

type Change = (event: { matches: boolean }) => void;

const setup = (print?: () => void) => {
  const frame = element();
  const root = element();
  const others: ReturnType<typeof element>[] = [];
  const afterPrint: (() => void)[] = [];
  const media = new Set<Change>();
  const seen: Record<string, string | undefined>[] = [];
  const win = {
    addEventListener: (_type: "afterprint", listener: () => void) => void afterPrint.push(listener),
    matchMedia: () => ({
      addEventListener: (_type: "change", listener: Change) => void media.add(listener),
      removeEventListener: (_type: "change", listener: Change) => void media.delete(listener),
    }),
    print: () => {
      seen.push({
        frame: frame.attributes.get(PRINT_ATTRIBUTE),
        root: root.attributes.get(PRINT_ATTRIBUTE),
        footer: frame.attributes.get(PRINT_FOOTER_ATTRIBUTE),
      });
      print?.();
    },
  };
  // Every element that carries either mark, as `querySelectorAll` would find them.
  const doc = {
    documentElement: root,
    querySelectorAll: () => [frame, root, ...others].filter((node) => node.attributes.size > 0),
  };
  const options = { title: "Allocation", today: new Date(2026, 10, 10), win, doc };
  return { frame, root, others, afterPrint, media, seen, options };
};

describe("printChart", () => {
  test("marks the frame and the page before the print dialog opens", () => {
    const { frame, seen, options } = setup();

    printChart(frame, options);

    expect(seen).toEqual([
      { frame: "frame", root: "page", footer: "Allocation · PromptFolio · 2026-11-10" },
    ]);
  });

  test("keeps the marks until the browser says printing is over, then removes them", () => {
    const { frame, root, afterPrint, options } = setup();

    printChart(frame, options);
    expect(frame.attributes.size).toBe(2);
    expect(root.attributes.size).toBe(1);

    afterPrint.forEach((listener) => listener());
    expect(frame.attributes.size).toBe(0);
    expect(root.attributes.size).toBe(0);
  });

  test("removes the marks when printing cannot start", () => {
    const { frame, root, options } = setup(() => {
      throw new Error("blocked");
    });

    expect(() => printChart(frame, options)).toThrow("blocked");
    expect(frame.attributes.size).toBe(0);
    expect(root.attributes.size).toBe(0);
  });

  test("clears a stale mark from an earlier export whose afterprint never came", () => {
    const { frame, others, seen, options } = setup();
    const stale = element({ [PRINT_ATTRIBUTE]: "frame", [PRINT_FOOTER_ATTRIBUTE]: "Old" });
    others.push(stale);

    printChart(frame, options);

    expect(stale.attributes.size).toBe(0);
    expect(seen[0]?.frame).toBe("frame");
  });

  test("also unmarks when the print media query ends, for browsers that skip afterprint", () => {
    const { frame, root, media, options } = setup();

    printChart(frame, options);
    // Entering print is not the end of it.
    media.forEach((listener) => listener({ matches: true }));
    expect(frame.attributes.size).toBe(2);

    media.forEach((listener) => listener({ matches: false }));
    expect(frame.attributes.size).toBe(0);
    expect(root.attributes.size).toBe(0);
    expect(media.size).toBe(0);
  });
});
