import index from "../web/index.html";
import { auth } from "./auth";
import { accountRoutes } from "./api/accounts";
import { importRoutes } from "./api/imports";
import { instrumentRoutes } from "./api/instruments";
import { portfolioRoutes } from "./api/portfolio";
import { getDb } from "./db";
import { startScheduler } from "./prices/refresh";

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
    development: Bun.env.NODE_ENV !== "production",
    routes: {
      "/api/auth/*": (request) => auth.handler(request),
      ...accountRoutes,
      ...instrumentRoutes,
      ...importRoutes,
      ...portfolioRoutes,
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
