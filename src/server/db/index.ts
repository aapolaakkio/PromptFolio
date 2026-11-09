import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";

/** The Worker's D1 database: `env.DB` is a runtime binding that `drizzle()` only wraps. Migrations do not run here (wrangler applies them before deploy): a Worker has no once-per-boot hook, so migrate-on-start would race every cold isolate. */
export const db = drizzle(env.DB);

export type Db = typeof db;

/** Bound parameters D1 accepts per statement; past it a query fails with "too many SQL variables". */
const MAX_SQL_VARIABLES = 100;

/** Splits `rows` into groups small enough for one insert given the columns each binds. Whole rows only: a split row would write two half-rows. */
export const chunkForInsert = <T>(rows: readonly T[], columnsPerRow: number): T[][] => {
  const perChunk = Math.max(1, Math.floor(MAX_SQL_VARIABLES / Math.max(1, columnsPerRow)));
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += perChunk) chunks.push(rows.slice(i, i + perChunk));
  return chunks;
};
