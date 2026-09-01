import { env } from "cloudflare:workers";

import { db } from "./index.ts";

/**
 * Empties every table, for a test that needs the database to itself.
 *
 * A fresh D1 per call would mean a workerd instance per call; the schema is
 * already there, so clearing the rows is the same isolation for none of the
 * cost. Foreign keys are deferred rather than ordered around: which table is a
 * parent is the schema's business, not this helper's.
 */
export const testDb = async () => {
  // Only this app's own tables. D1 keeps `_cf_METADATA` and SQLite keeps
  // `sqlite_sequence` for itself, and a DELETE against either is refused with
  // `SQLITE_AUTH` -- which would fail the whole batch, including the rows that
  // were the point of it.
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' " +
      "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' " +
      "AND name NOT LIKE 'd1\\_%' ESCAPE '\\' AND name != '__drizzle_migrations'",
  ).all<{ name: string }>();

  await env.DB.prepare("PRAGMA defer_foreign_keys = true").run();
  await env.DB.batch(tables.results.map((table) => env.DB.prepare(`DELETE FROM "${table.name}"`)));

  // `binding` is the D1 itself, for the few tests that seed with raw SQL rather
  // than through Drizzle -- checking a column the schema does not model, or
  // writing a row the query builder would refuse.
  return { db, binding: env.DB };
};
