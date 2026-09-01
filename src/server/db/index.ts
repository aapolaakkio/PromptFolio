import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";

/**
 * The Worker's D1 database.
 *
 * Nothing to open and no handle to keep alive, unlike the file-backed SQLite
 * this replaced: `env.DB` is a binding the runtime hands us and `drizzle()`
 * only wraps it.
 *
 * Migrations do not run here. Wrangler applies them before a deploy
 * (`pnpm run db:migrate`); a Worker has no once-per-boot hook, so the old
 * migrate-on-start would have raced every cold isolate.
 */
export const db = drizzle(env.DB);

export type Db = typeof db;

/**
 * How many bound parameters D1 accepts in one statement. Past it the query
 * fails with "too many SQL variables", which file-backed SQLite never did --
 * so a multi-row insert that was fine before can be too big here.
 */
const MAX_SQL_VARIABLES = 100;

/**
 * Splits `rows` into groups small enough for one insert, given how many columns
 * each row binds. Callers insert group by group rather than in one statement.
 *
 * Returns whole rows, never a partial one: a row split across two statements
 * would write two half-rows.
 */
export const chunkForInsert = <T>(rows: readonly T[], columnsPerRow: number): T[][] => {
  const perChunk = Math.max(1, Math.floor(MAX_SQL_VARIABLES / Math.max(1, columnsPerRow)));
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += perChunk) chunks.push(rows.slice(i, i + perChunk));
  return chunks;
};
