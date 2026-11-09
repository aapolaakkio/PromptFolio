import { env } from "cloudflare:workers";

import { db } from "./index.ts";

/** Empties every table, for a test that needs the database to itself (cheaper than a fresh D1 per call). Foreign keys are deferred, so parent order is not this helper's business. */
export const testDb = async () => {
  // This app's tables only: D1's `_cf_METADATA` and SQLite's `sqlite_sequence` refuse DELETE with `SQLITE_AUTH`, which would fail the whole batch.
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' " +
      "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' " +
      "AND name NOT LIKE 'd1\\_%' ESCAPE '\\' AND name != '__drizzle_migrations'",
  ).all<{ name: string }>();

  await env.DB.prepare("PRAGMA defer_foreign_keys = true").run();
  await env.DB.batch(tables.results.map((table) => env.DB.prepare(`DELETE FROM "${table.name}"`)));

  // `binding` is the D1 itself, for tests seeding with raw SQL (a column the schema does not model, or a row the builder would refuse).
  return { db, binding: env.DB };
};
