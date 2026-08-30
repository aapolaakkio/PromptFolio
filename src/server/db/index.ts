import { resolve } from "node:path";

import { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate as runMigrations } from "drizzle-orm/node-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

export const openDb = (path: string = process.env.DATABASE_PATH ?? "./data/promptfolio.db") => {
  // node:sqlite creates the file by default and has no "strict" mode to ask
  // for: its own binding already refuses the loose value coercions that flag
  // turned off in node:sqlite.
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA busy_timeout = 5000");
  return { sqlite, db: drizzle({ client: sqlite }) };
};

/**
 * Resolved against this module's own location (`import.meta.dirname`), not
 * `process.cwd()` -- a relative `"./drizzle"` would otherwise depend on
 * whatever directory the process happened to be started from, which a
 * container image or a different launcher can easily get wrong.
 */
const MIGRATIONS_FOLDER = resolve(import.meta.dirname, "../../../drizzle");

/**
 * A migrations folder that exists but is empty makes `runMigrations` apply
 * nothing and return undefined, which is indistinguishable from success. Reading
 * the files up front turns that silent no-op into a loud error.
 */
export const migrate = (
  db: ReturnType<typeof openDb>["db"],
  opts: { migrationsFolder?: string } = {},
): void => {
  const migrationsFolder = opts.migrationsFolder ?? MIGRATIONS_FOLDER;

  if (readMigrationFiles({ migrationsFolder }).length === 0) {
    throw new Error(`Migraatiohakemistosta ei löytynyt yhtään migraatiota: ${migrationsFolder}`);
  }

  // A migration that rebuilds a table has to drop the old one, which fires the
  // children's cascade. The generated SQL guards against that, but SQLite ignores
  // the pragma inside a transaction and the migrator runs in one -- so it is set
  // here, before the transaction, where it takes effect.
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

// One handle for the process: a connection per module for the same file defeats
// WAL's single-writer assumption. Call getDb(), never openDb(), outside tests.
let sharedHandle: ReturnType<typeof openDb> | undefined;

export const getDb = (): ReturnType<typeof openDb> => {
  sharedHandle ??= openDb();
  return sharedHandle;
};

/**
 * Test-only: drops the memoised handle so the next call opens a fresh one.
 * Without it, the first test file to seed the handle leaks it into every other
 * file for the rest of the process.
 */
export const resetDbHandleForTests = (): void => {
  sharedHandle = undefined;
};
