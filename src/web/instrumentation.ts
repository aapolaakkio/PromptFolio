import { resolve } from "node:path";

import { getDb, migrate } from "../server/db/index.ts";

/**
 * Run once when the server starts, before it answers anything -- the same shape
 * and the same job as Next's `instrumentation.ts`, called from the server entry.
 *
 * A fresh volume has no database file until the first connection makes one, and
 * no tables until this runs. Migrations are additive and tracked, so every later
 * boot is a cheap no-op.
 *
 * The folder is resolved from the working directory rather than this module's
 * own: the bundle lives in dist/ while the migrations stay beside the source.
 *
 * The nightly price refresh is deliberately not started here. An in-process
 * timer only runs while the server does, restarts its clock on every deploy, and
 * fires twice if the app is ever run as two processes -- so it is a route an
 * outside cron calls instead (see app/api/cron/refresh.ts).
 */
export const register = (): void => {
  migrate(getDb().db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
};
