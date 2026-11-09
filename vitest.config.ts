import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Node has no `cloudflare:workers`; the stand-in serves wrangler's binding proxy over a real local D1.
      "cloudflare:workers": resolve(import.meta.dirname, "src/server/test-cloudflare-env.ts"),
    },
  },
  test: {
    environment: "node",
    globalSetup: ["./src/server/test-reap-workerd.ts"],
    // Pins getDb() to a migrated in-memory DB and makes global fetch throw; process-wide, so before any import.
    setupFiles: ["./src/server/test-setup.ts", "./src/server/test-network-guard.ts"],
    // One process: the setup pins a single DB handle per process and tests assert on that shared state.
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
    exclude: ["node_modules/**", "dist/**", "e2e/**", "tools/oxlint/anti-slop/**"],
    coverage: {
      provider: "v8",
      // 80 % across the project, lines only: V8 counts every callback as a function, so a function threshold would be a different bar. Page components sit at 0 % (never rendered), so a per-file gate would fail.
      thresholds: { lines: 80 },
      // Code only: fixtures are data with no lines to execute.
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/**/fixtures/**"],
      // Only what the tests load.
      all: false,
    },
  },
});
