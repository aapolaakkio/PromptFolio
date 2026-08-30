import { resolve } from "node:path";

import { Database } from "bun:sqlite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate as runMigrations } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

export const openDb = (path: string = process.env.DATABASE_PATH ?? "./data/promptfolio.db") => {
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA busy_timeout = 5000");
  return { sqlite, db: drizzle({ client: sqlite }) };
};

/**
 * Resolved against this module's own location (`import.meta.dir`), not
 * `process.cwd()` -- a relative `"./drizzle"` would otherwise depend on
 * whatever directory the process happened to be started from, which a
 * container image or a different launcher can easily get wrong.
 */
const MIGRATIONS_FOLDER = resolve(import.meta.dir, "../../../drizzle");

/**
 * `runMigrations` can silently apply zero migrations and return
 * `undefined` -- indistinguishable from success -- when pointed at a
 * migrations folder that exists but has nothing in it (reproduced
 * directly; see task-15-report.md's fix-up section). `readMigrationFiles`
 * is the same function `runMigrations` uses internally to find what to
 * apply, called here up front so that silent no-op becomes a loud error
 * instead of a trusted empty return value. Its own return value
 * (`void | MigratorInitFailResponse`) is checked too, rather than
 * discarded, for the same reason.
 */
export const migrate = (
  db: ReturnType<typeof openDb>["db"],
  opts: { migrationsFolder?: string } = {},
): void => {
  const migrationsFolder = opts.migrationsFolder ?? MIGRATIONS_FOLDER;

  if (readMigrationFiles({ migrationsFolder }).length === 0) {
    throw new Error(`Migraatiohakemistosta ei löytynyt yhtään migraatiota: ${migrationsFolder}`);
  }

  // Foreign keys are enforced on every ordinary connection (openDb turns them
  // on), but a migration that rebuilds a table -- SQLite's only way to relax a
  // column constraint -- must drop the old one, and DROP TABLE fires the
  // children's ON DELETE CASCADE. drizzle-kit's generated SQL guards against
  // that with `PRAGMA foreign_keys=OFF`, which SQLite silently ignores inside
  // a transaction, and the migrator runs every migration in one. Setting it
  // here, before the transaction begins, is where it actually takes effect.
  // Restored afterwards whether or not the migration succeeds.
  db.run(sql`PRAGMA foreign_keys = OFF`);
  let result: void | { exitCode: number };
  try {
    // SAFETY: the migrator is typed as returning `void | MigratorInitFailResponse`,
    // whose only field this code reads is `exitCode`; narrowing to that shape
    // keeps the failure check below without importing an internal type.
    result = runMigrations(db, { migrationsFolder }) as void | { exitCode: number };
  } finally {
    db.run(sql`PRAGMA foreign_keys = ON`);
  }
  if (result !== undefined) {
    throw new Error(
      `Tietokannan migraatio epäonnistui (${result.exitCode}). Migraatiohakemisto: ${migrationsFolder}`,
    );
  }
};

/** In-memory database with migrations applied. Used by every server-side test. */
export const testDb = () => {
  const handle = openDb(":memory:");
  migrate(handle.db);
  return handle;
};

// --- Shared connection ---
//
// Five-plus later tasks (routers, services) each need a database handle.
// Calling openDb() from each of their modules would open a separate
// bun:sqlite connection per module for the same file, defeating WAL's
// single-writer assumptions. getDb() lazily opens ONE handle on first call
// and hands out that same handle to every caller for the lifetime of the
// process. Route modules should import and call getDb(), never openDb(),
// except in tests, which want their own isolated in-memory database via
// testDb().
let sharedHandle: ReturnType<typeof openDb> | undefined;

export const getDb = (): ReturnType<typeof openDb> => {
  sharedHandle ??= openDb();
  return sharedHandle;
};

/**
 * Test-only: clears the memoised shared handle so the next getDb() call
 * opens a fresh connection. `getDb()` memoises into a process-lifetime
 * module global, so once one test file seeds it (e.g. with an in-memory
 * database via DATABASE_PATH), that handle otherwise leaks into every
 * other test file for the rest of the `bun test` process. Call this before
 * a test needs its own isolated getDb() handle.
 */
export const resetDbHandleForTests = (): void => {
  sharedHandle = undefined;
};
