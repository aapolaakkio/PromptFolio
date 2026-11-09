import { expect, test } from "vitest";

import {
  applyStoredTheme,
  nextChoice,
  resolveTheme,
  THEME_SCRIPT,
  type ThemeDocument,
} from "./theme.ts";

test("the switch cycles system, light, dark", () => {
  expect(nextChoice("system")).toBe("light");
  expect(nextChoice("light")).toBe("dark");
  expect(nextChoice("dark")).toBe("system");
});

test("a choice wins over the system; system follows it", () => {
  expect(resolveTheme("light", true)).toBe("light");
  expect(resolveTheme("dark", false)).toBe("dark");
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
});

test("before first paint, data-theme comes from the stored choice, else the system", () => {
  const run = (stored: string | null, prefersDark: boolean): string | undefined => {
    const doc: ThemeDocument = { documentElement: { dataset: {} } };
    applyStoredTheme({ getItem: () => stored }, () => ({ matches: prefersDark }), doc);
    return doc.documentElement.dataset.theme;
  };
  expect(run("dark", false)).toBe("dark");
  expect(run("light", true)).toBe("light");
  expect(run(null, true)).toBe("dark");
  expect(run("nonsense", false)).toBe("light");
});

test("the inline script is that same function, called with the browser's globals", () => {
  expect(THEME_SCRIPT).toContain(applyStoredTheme.toString());
  expect(THEME_SCRIPT).toContain("(localStorage, matchMedia, document)");
});
