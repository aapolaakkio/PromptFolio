import handler from "@tanstack/react-start/server-entry";

import { db } from "./server/db/index.ts";
import { runScheduledRefresh } from "./server/prices/refresh.ts";

/**
 * The Worker: TanStack Start answers every request, and the Cron Trigger in
 * wrangler.jsonc runs the day's price and rate refresh. `waitUntil` keeps the
 * Worker alive for the whole refresh; each phase catches its own failure, so
 * one source being down never stops the rest.
 */
export default {
  // Only the request: Workers would pass `env` second, where TanStack expects
  // its own options. Bindings reach the app through `cloudflare:workers`.
  fetch: (request) => handler.fetch(request),
  scheduled(_event, _env, ctx) {
    ctx.waitUntil(runScheduledRefresh(db));
  },
} satisfies ExportedHandler<Env>;
