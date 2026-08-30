/**
 * Runs once, before any `*.test.ts` file loads, via vitest.config.ts's
 * `[test] preload`. This is the *only* place in the whole `vitest`
 * process allowed to decide the shared database's identity.
 *
 * Why this has to exist: `getDb()` (src/server/db/index.ts) memoises a
 * single shared database handle for the lifetime of the process, and
 * auth.ts calls it at module scope while itself being an ES module
 * singleton — so whichever code path calls `getDb()` (directly, or by
 * importing auth.ts) *first* in a `vitest` run permanently decides which
 * database every later `getDb()` caller gets, including every other test
 * file's dynamically-imported auth.ts / accounts.ts / instruments.ts.
 *
 * Two failure modes follow from that if it isn't pinned down before
 * anything else runs:
 *  - If some test file called `resetDbHandleForTests()` in its own
 *    `beforeAll`, a *later* file's independent reset would silently create
 *    a second, different database that only *that* file's own
 *    freshly-imported route module bound to, while the already-cached
 *    auth.ts kept pointing at the first one — sign-up would write a user to
 *    one database while a route's insert looked for that user's id as a
 *    foreign key in the other. This is not hypothetical: it happened
 *    during Task 9's development (see task-9-report.md and its fix-up
 *    report) once more than one test file tried to own this setup.
 *  - If nothing had reset *or* pinned `DATABASE_PATH` before the first
 *    `getDb()` call, that first call would silently open the real on-disk
 *    database at its default path — a financial app's test suite writing
 *    into production data on a mis-scheduled run is a much worse failure
 *    than a loud one.
 *
 * Bun's `[test] preload` scripts run before every test file's own
 * top-level code, deterministically, regardless of which files were named
 * on the command line or how Bun schedules them relative to each other.
 * That determinism is the whole fix: no test file in this project may call
 * `resetDbHandleForTests()`, set `DATABASE_PATH`, or call `getDb()` before
 * this file already has — because this file always runs first. Every
 * later test file's `beforeAll` for a session-backed test (currently
 * src/server/auth.test.ts, src/server/api/accounts.test.ts,
 * src/server/api/instruments.test.ts) can safely assume the shared handle
 * already points at a migrated in-memory database whose `auth.ts` (once
 * dynamically imported) will bind to that same handle.
 */
import { getDb, migrate } from "./db/index.ts";

process.env.DATABASE_PATH = ":memory:";
process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-characters-long";
process.env.ALLOW_SIGNUP = "true";

const { db } = getDb();
migrate(db);
