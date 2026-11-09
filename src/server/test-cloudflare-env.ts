import { drizzle } from "drizzle-orm/d1";
import { migrate } from "drizzle-orm/d1/migrator";
import { getPlatformProxy } from "wrangler";

/** Stands in for `cloudflare:workers` under vitest (Node), aliased in vitest.config.ts. `getPlatformProxy` gives tests a real D1 while the suite stays in Node, where PDF and CSV fixtures are readable. One database for the whole process, migrated here, so load order cannot decide what callers see. */
// No remote bindings: the AI binding would open a Cloudflare session at startup.
const proxy = await getPlatformProxy<Cloudflare.Env>({ persist: false, remoteBindings: false });

/** Vars are pinned, not taken from wrangler.jsonc or `.env`, so results do not depend on untracked files; `ALLOW_SIGNUP` must be "true" for tests to create sessions. Only the D1 binding comes from the proxy. */
export const env: Cloudflare.Env = Object.assign(proxy.env, {
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long",
  BASE_URL: "http://localhost:3000",
  ALLOW_SIGNUP: "true",
  // Claude calls use an injected fetch in tests (the global one throws, see test-network-guard.ts); the key is a placeholder.
  ANTHROPIC_API_KEY: "test-anthropic-key",
  AI_GATEWAY_ID: "",
  AI_GATEWAY_TOKEN: "",
  AI: {
    run: () => {
      throw new Error("network blocked in tests: Workers AI");
    },
  },
  CRON_SECRET: "test-cron-secret",
});

await migrate(drizzle(env.DB), { migrationsFolder: "drizzle" });

/** Stops this file's local workerd: each test file starts its own proxy, which otherwise leaked one workerd per file. */
export const disposePlatform = (): Promise<void> => proxy.dispose();
