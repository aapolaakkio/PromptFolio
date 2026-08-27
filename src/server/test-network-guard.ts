/**
 * Runs once, before any `*.test.ts` file loads, via `bunfig.toml`'s
 * `[test] preload` -- the same mechanism `test-setup.ts` already uses to
 * pin the shared test database, extended with a second entry rather than
 * a second, different bootstrap mechanism.
 *
 * Replaces the real global `fetch` with one that throws immediately.
 * "NO LIVE NETWORK CALLS IN THE TEST SUITE, EVER" (Task 14's brief) held
 * only as a property of every test file happening to pass its own
 * `fetchImpl` -- nothing in the committed suite enforced it. A future
 * price-source test (or any other test) that forgets to inject `fetchImpl`
 * would silently fall through to the real network: slower, flaky, and
 * exactly the kind of thing that stops failing loudly.
 *
 * Deliberately project-wide, not scoped to `src/server/prices/`: nothing
 * anywhere in this project's committed test suite calls the real network
 * today (checked: no `*.test.ts` file calls bare `fetch(...)` outside a
 * `fetchImpl` stub), so a blanket guard is both the simplest option and
 * the strongest guarantee. A future test that genuinely needs the real
 * network should inject a `fetchImpl` that reaches it deliberately, not
 * rely on the ambient global -- which is already every `PriceSource`'s
 * contract, so this changes no legitimate test's behaviour.
 *
 * Declared as a `function`+`namespace` merge (not a plain arrow function
 * cast with `as typeof fetch`) so it structurally satisfies Bun's
 * `typeof fetch`, which requires a static `preconnect` method that a bare
 * function value does not have -- see `src/server/prices/types.ts`'s
 * `FetchImpl` comment for the same issue on the production side.
 */
// Marks this file as a module (it otherwise has no top-level import/export)
// so the `function`+`namespace` merge below is allowed at all --
// `verbatimModuleSyntax` disallows namespaces in a global script file.
export {};

function blockedFetch(): Promise<Response> {
  throw new Error(
    "network blocked in tests: this call reached the real global fetch instead of an injected " +
      "fetchImpl. Pass fetchImpl explicitly (see src/server/prices/*.test.ts for the pattern) -- " +
      "no test in this project may touch the real network.",
  );
}
namespace blockedFetch {
  export function preconnect(): void {
    // No-op: nothing in the test suite calls fetch.preconnect either, but
    // the static method must exist for `blockedFetch` to satisfy `typeof
    // fetch`'s shape.
  }
}

globalThis.fetch = blockedFetch;
