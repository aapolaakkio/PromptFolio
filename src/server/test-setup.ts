/** Runs before any test file via vitest `setupFiles`: importing `cloudflare:workers` (aliased to ./test-cloudflare-env.ts) creates and migrates the local D1. Done here, not in `beforeAll`, because `db` is a module-scope constant: the first importer would otherwise pick the database for every later caller. */
import { afterAll } from "vitest";

import "./db/index.ts";
import { disposePlatform } from "./test-cloudflare-env.ts";

// Without this every test file leaves its workerd running.
afterAll(disposePlatform);
