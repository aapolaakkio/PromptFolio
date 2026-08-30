import { expect, test } from "vitest";

/**
 * Exercises `test-network-guard.ts` itself (preloaded by every `vitest`
 * run, see vitest.config.ts) rather than relying on a throwaway manual check
 * that isn't committed anywhere. A passing suite is direct, ongoing proof
 * that a test which forgets to inject its own `fetchImpl` fails loudly
 * instead of silently reaching the real network -- not just a property
 * that happened to hold on the day this was written.
 */

test("the real global fetch is replaced with one that throws, not silently reaches the network", () => {
  expect(() => fetch("https://example.com")).toThrow(/network blocked in tests/);
});

test("fetch.preconnect stays callable (a harmless no-op) so code that calls it doesn't crash", () => {
  expect(() => fetch.preconnect("https://example.com")).not.toThrow();
});
