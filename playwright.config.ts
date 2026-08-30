import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;

// Its own database file, wiped and seeded by the global setup, so a run never
// touches the real ledger in ./data.
const DATABASE_PATH = "./e2e/.tmp/e2e.db";

export default defineConfig({
  testDir: "./e2e",
  // One browser at a time: the app is a single-owner instance, and the
  // first-run form can only ever be filled once per database.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: BASE_URL, trace: "on-first-retry" },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }],
  webServer: {
    // Seeded here rather than in a globalSetup, which Playwright runs only
    // after the server is already up and reading the file.
    command: `node e2e/seed.ts && pnpm exec vite dev --port ${PORT} --strictPort`,
    url: BASE_URL,
    // Never an existing dev server: that one is pointed at the real database.
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      DATABASE_PATH,
      BASE_URL,
      BETTER_AUTH_SECRET: "e2e-secret-that-is-long-enough-to-be-accepted",
      ALLOW_SIGNUP: "true",
      NODE_ENV: "development",
    },
  },
});
