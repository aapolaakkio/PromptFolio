// Task 17 creates src/web/index.html and restores this import plus the
// '/*' route below, which serves the compiled SPA shell for any path that
// isn't an API route. Until then, importing it would fail to resolve.
// import index from "../web/index.html";
import { auth } from "./auth";
import { accountRoutes } from "./api/accounts";
import { importRoutes } from "./api/imports";
import { instrumentRoutes } from "./api/instruments";
import { portfolioRoutes } from "./api/portfolio";
import { getDb } from "./db";
import { startScheduler } from "./prices/refresh";

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  development: Bun.env.NODE_ENV !== "production",
  routes: {
    "/api/auth/*": (request) => auth.handler(request),
    ...accountRoutes,
    ...instrumentRoutes,
    ...importRoutes,
    ...portfolioRoutes,
    // '/*': index, // Task 17 restores this once src/web/index.html exists.
  },
});

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
