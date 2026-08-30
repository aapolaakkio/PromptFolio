/**
 * Runs before any test file loads, via vitest.config.ts's setup files.
 *
 * Replaces the global `fetch` with one that throws. "No live network calls in
 * the test suite, ever" held only as a property of every file happening to pass
 * its own `fetchImpl`, and a test that forgot would silently reach the real
 * network: slower, flaky, and exactly the kind of thing that stops failing
 * loudly. A test that genuinely needs the network should inject a `fetchImpl`
 * that reaches it deliberately.
 */
globalThis.fetch = (): Promise<Response> => {
  throw new Error(
    "network blocked in tests: this call reached the real global fetch instead of an injected " +
      "fetchImpl. Pass fetchImpl explicitly (see src/server/prices/*.test.ts for the pattern) -- " +
      "no test in this project may touch the real network.",
  );
};
