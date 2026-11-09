import { expect, test } from "vitest";

/** Proves the preloaded guard makes a test that forgets to inject its `fetchImpl` fail loudly instead of reaching the real network. */

test("the real global fetch is replaced with one that throws, not silently reaches the network", async () => {
  expect(() => fetch("https://example.com")).toThrow(/network blocked in tests/);
});
