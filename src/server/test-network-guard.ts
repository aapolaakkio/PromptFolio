/** Runs before any test file (vitest setup files): replaces global `fetch` with one that throws, so a test that forgets to inject `fetchImpl` fails loudly instead of silently reaching the network. A test that needs the network injects one deliberately. */
globalThis.fetch = (): Promise<Response> => {
  throw new Error(
    "network blocked in tests: this call reached the real global fetch instead of an injected " +
      "fetchImpl. Pass fetchImpl explicitly (see src/server/prices/*.test.ts for the pattern) -- " +
      "no test in this project may touch the real network.",
  );
};
