import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The suite runs in Node, which has no `cloudflare:workers`. The
      // stand-in serves wrangler's own binding proxy, so `db` and every env
      // read work unchanged against a real local D1.
      "cloudflare:workers": resolve(import.meta.dirname, "src/server/test-cloudflare-env.ts"),
    },
  },
  test: {
    environment: "node",
    // Pins the shared getDb() handle to a
    // migrated in-memory database before any test file's own code runs, and
    // replace the global fetch with one that throws. Both are process-wide, so
    // they have to happen before the first import, not in a beforeAll.
    setupFiles: ["./src/server/test-setup.ts", "./src/server/test-network-guard.ts"],
    // One process for the whole suite. The setup above
    // pins a single database handle per process and several tests assert on
    // that shared state, so a worker pool would give each file its own and the
    // assertions would stop meaning anything.
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
    exclude: ["node_modules/**", "dist/**", "e2e/**", "tools/oxlint/anti-slop/**"],
    coverage: {
      provider: "v8",
      // 80 % across the project, not
      // per file. Several page components sit at 0 % and always did -- they are
      // loaded by the route-tree test but never rendered by it -- so a per-file
      // gate fails on day one. Worth tightening later, as its own change with
      // its own tests; a migration that quietly moves a quality bar is a
      // migration nobody can review.
      // Lines only. Runners count *functions* differently -- V8 counts every
      // arrow and callback as its own -- so a function threshold carried across
      // would be a different bar wearing the old number (71.8 % here against
      // a far lower figure than a per-function count. Lines are comparable.
      thresholds: { lines: 80 },
      // Code only: `src/**` also swept up the JSON fixtures, which are data and
      // scored 0 % for having no lines to execute.
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/**/fixtures/**"],
      // Only what the tests actually load.
      // Widening this to every file in the tree is a real tightening of the
      // floor and a decision of its own; it is not part of changing runners.
      all: false,
    },
  },
});
