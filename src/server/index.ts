import index from "../web/index.html";
import { auth } from "./auth";
import { accountRoutes } from "./api/accounts";
import { bankImportRoutes } from "./api/bank-imports";
import { cashEntryRoutes } from "./api/cash-entries";
import { chatRoutes } from "./api/chat";
import { importRoutes } from "./api/imports";
import { instrumentRoutes } from "./api/instruments";
import { portfolioRoutes } from "./api/portfolio";
import { priceRoutes } from "./api/prices";
import { snapshotRoutes } from "./api/snapshots";
import { setupRoutes } from "./api/setup";
import { getDb, migrate } from "./db";
import { startScheduler } from "./prices/refresh";

/**
 * Liveness check for the container's `HEALTHCHECK` (and any external
 * uptime monitor). Deliberately does not query the database: a slow or
 * locked SQLite file (WAL checkpoint, a long-running import) must not
 * read as "unhealthy" and cause Docker to restart a container that is
 * otherwise fine -- that would turn a slow query into a restart loop.
 * Deliberately unauthenticated too, same reason `auth.handler` is never
 * consulted here: a health check that requires a session cookie cannot be
 * called by `docker inspect`'s HEALTHCHECK or a bare `curl`.
 */
const healthRoute = { GET: () => Response.json({ ok: true }) };

/**
 * Builds and starts the real `Bun.serve` instance -- routes unchanged from
 * before this factory existed, just no longer run as a top-level side
 * effect of importing this module. `opts.port` defaults to `PORT` (itself
 * defaulting to 3000) exactly as the top-level call used to; passing `0`
 * asks the OS for any free port, which is what task-21's end-to-end test
 * (run as a genuine child process -- see e2e/import-to-holdings.test.ts's
 * own comment for why it is a separate process rather than an in-process
 * `createServer()` call) uses to avoid colliding with a real dev server or
 * another test run on the same machine.
 */
export const createServer = (opts: { port?: number } = {}): ReturnType<typeof Bun.serve> =>
  Bun.serve({
    port: opts.port ?? Number(Bun.env.PORT ?? 3000),
    /**
     * Bun closes a connection that has been idle for 10 seconds by default. A
     * chat turn is several model round trips and routinely quiet for longer
     * than that between events, so the answer was being cut off mid-stream --
     * "Bun.serve() timed out a request after 10 seconds" in the log, and a
     * failed turn in the browser. 255 is the maximum Bun accepts.
     */
    idleTimeout: 255,
    // HMR is off deliberately. Bun's dev server hot-swaps route modules, and
    // TanStack Router's own hot-update handler reads a router that is null
    // during that swap -- "Cannot read properties of null (reading
    // 'replaceRouteChunk')" -- which takes the whole page down until a hard
    // reload. A full reload on change is the cheaper trade: this app's pages
    // hold no state a reload loses. `console` keeps browser errors visible in
    // the server's own log, which is how that crash was found.
    development: Bun.env.NODE_ENV === "production" ? false : { hmr: false, console: true },
    routes: {
      "/api/health": healthRoute,
      "/api/auth/*": (request) => auth.handler(request),
      ...setupRoutes,
      ...accountRoutes,
      ...bankImportRoutes,
      ...cashEntryRoutes,
      ...chatRoutes,
      ...instrumentRoutes,
      ...importRoutes,
      ...portfolioRoutes,
      ...priceRoutes,
      ...snapshotRoutes,
      "/*": index,
    },
  });

// Starting the real server, the production scheduler, and the process-wide
// unhandledRejection guard is only appropriate for an actual `bun
// src/server/index.ts` run (`bun run dev` / `bun start`), never as a side
// effect of some other module (or a test file) importing this one for its
// `createServer` export. `import.meta.main` is true only for the entry
// module Bun itself was invoked with, so this whole block is skipped on
// every import that isn't that.
if (import.meta.main) {
  // Applies any migration the current database file is missing before the
  // server starts accepting requests -- a fresh Docker volume has no
  // database file at all until `openDb()` creates one, and no tables in
  // it until this runs. Migrations are additive and idempotent (drizzle
  // tracks what has already been applied in its own bookkeeping table),
  // so re-running this against an already-current database on every boot
  // is safe and cheap, not just safe on first boot.
  const { db } = getDb();
  migrate(db);

  const server = createServer();
  console.log(`PromptFolio kuuntelee osoitteessa ${server.url}`);

  // The daily FX/price refresh only runs in production: a `bun --hot` dev
  // server would re-register the job on every save, and no *.test.ts file
  // imports this module (checked directly -- see task-15-report.md), so
  // `bun test` never reaches this line either way. Guarding on NODE_ENV
  // explicitly, rather than relying on either of those incidental facts, is
  // what keeps a stray `bun run src/server/index.ts` outside `bun start`
  // from silently registering a real scheduled job too.
  if (Bun.env.NODE_ENV === "production") {
    startScheduler(getDb().db);
  }

  // Bun.cron mirrors setTimeout's error semantics: a handler whose returned
  // Promise rejects, with no `unhandledRejection` listener registered, exits
  // the whole process. `runScheduledRefresh` (prices/refresh.ts) already
  // wraps its own body in try/catch so it should never actually reject --
  // this listener is the second, independent layer of defense the design
  // doc calls for, for anything that still escapes.
  process.on("unhandledRejection", (cause) => {
    console.error("Käsittelemätön virhe (unhandledRejection)", cause);
  });
}
