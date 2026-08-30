import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Vite has a BASE_URL of its own -- the public base path, "/" -- and it
    // reaches process.env, where this app reads its own BASE_URL and hands it
    // to Better Auth, which rejects "/" as not a URL. Pinned here rather than
    // left to collide, and pinned rather than read from a developer's .env: a
    // suite whose result depends on an untracked file is not a suite.
    env: {
      BASE_URL: "http://localhost:3000",
      // Present so the classification path runs at all: the code skips it when
      // there is no key. It was passing only because Bun loaded the developer's
      // own .env, which made the suite's result depend on an untracked file --
      // and on a real key sitting in the environment of every test run. The
      // network guard in setupFiles is what stops it reaching Anthropic.
      ANTHROPIC_API_KEY: "test-key-never-used",
    },
    // What bunfig.toml's [test] preload did: pin the shared getDb() handle to a
    // migrated in-memory database before any test file's own code runs, and
    // replace the global fetch with one that throws. Both are process-wide, so
    // they have to happen before the first import, not in a beforeAll.
    setupFiles: ["./src/server/test-setup.ts", "./src/server/test-network-guard.ts"],
    // One process for the whole suite, as `bun test` ran it. The setup above
    // pins a single database handle per process and several tests assert on
    // that shared state, so a worker pool would give each file its own and the
    // assertions would stop meaning anything.
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
    exclude: ["node_modules/**", "dist/**", "e2e/**", "tools/oxlint/anti-slop/**"],
    coverage: {
      provider: "v8",
      // The floor bunfig.toml actually enforced: 80 % across the project, not
      // per file. Several page components sit at 0 % and always did -- they are
      // loaded by the route-tree test but never rendered by it -- so a per-file
      // gate fails on day one. Worth tightening later, as its own change with
      // its own tests; a migration that quietly moves a quality bar is a
      // migration nobody can review.
      // Lines only. Bun and V8 count *functions* differently -- V8 counts every
      // arrow and callback as its own -- so a function threshold carried across
      // would be a different bar wearing the old number (71.8 % here against
      // Bun's reported 80+). Lines are comparable, and 80 is what was enforced.
      thresholds: { lines: 80 },
      // Code only: `src/**` also swept up the JSON fixtures, which are data and
      // scored 0 % for having no lines to execute.
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/**/fixtures/**"],
      // Only what the tests actually load, which is what `bun test` measured.
      // Widening this to every file in the tree is a real tightening of the
      // floor and a decision of its own; it is not part of changing runners.
      all: false,
    },
  },
});
