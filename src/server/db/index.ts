import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate as runMigrations } from "drizzle-orm/bun-sqlite/migrator";

export const openDb = (path: string = Bun.env.DATABASE_PATH ?? "./data/promptfolio.db") => {
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA busy_timeout = 5000");
  return { sqlite, db: drizzle({ client: sqlite }) };
};

export const migrate = (db: ReturnType<typeof openDb>["db"]): void => {
  runMigrations(db, { migrationsFolder: "./drizzle" });
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
