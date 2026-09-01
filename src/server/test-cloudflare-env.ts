import { drizzle } from "drizzle-orm/d1";
import { migrate } from "drizzle-orm/d1/migrator";
import { getPlatformProxy } from "wrangler";

/**
 * Stands in for `cloudflare:workers` under vitest, which runs in Node and has
 * no such module. Aliased in vitest.config.ts.
 *
 * `getPlatformProxy` is wrangler's own way to reach the bindings in
 * wrangler.jsonc from a Node process, so tests get a real D1 rather than a
 * stand-in for one -- and the suite stays in Node, where the PDF and CSV
 * fixtures can still be read from disk.
 *
 * One database for the whole process, migrated here: `db` is a module-scope
 * constant, so whichever module loads first would otherwise decide what every
 * later caller sees.
 */
const proxy = await getPlatformProxy<Cloudflare.Env>({ persist: false });

/**
 * The vars are pinned rather than taken from wrangler.jsonc or a developer's
 * `.env`: a suite whose result depends on an untracked file is not a suite, and
 * `ALLOW_SIGNUP` in particular has to be "true" here so tests can create the
 * real sessions they assert against. Only the D1 binding comes from the proxy.
 */
export const env: Cloudflare.Env = Object.assign(proxy.env, {
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long",
  BASE_URL: "http://localhost:3000",
  ALLOW_SIGNUP: "true",
  // Present so the classification path runs at all -- the code skips it when
  // there is no key. test-network-guard.ts is what stops it reaching Anthropic.
  ANTHROPIC_API_KEY: "test-key-never-used",
  CRON_SECRET: "test-cron-secret",
});

await migrate(drizzle(env.DB), { migrationsFolder: "drizzle" });
