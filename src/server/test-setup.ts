/**
 * Runs before any `*.test.ts` file loads, via vitest.config.ts's `setupFiles`.
 *
 * Importing `cloudflare:workers` (aliased to ./test-cloudflare-env.ts) is what
 * creates the local D1 and migrates it. Doing that here rather than in a
 * `beforeAll` matters because `db` is a module-scope constant: whichever test
 * file imported it first would otherwise decide which database every later
 * caller binds to, and a sign-up would write a user to one database while a
 * route looked for that user's id as a foreign key in another.
 */
import { afterAll } from "vitest";

import "./db/index.ts";
import { disposePlatform } from "./test-cloudflare-env.ts";

// Without this every test file leaves its workerd running after the run.
afterAll(disposePlatform);
