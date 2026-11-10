import handler from "@tanstack/react-start/server-entry";
import { env } from "cloudflare:workers";

import { db } from "./server/db/index.ts";
import { pageDeps } from "./server/instruments/find-page.ts";
import { resolvePending } from "./server/instruments/resolve-pending.ts";
import { refreshIntraday } from "./server/prices/intraday.ts";
import { runScheduledRefresh } from "./server/prices/refresh.ts";
import { installUpstreamOverride } from "./server/upstream-override.ts";

installUpstreamOverride(env.E2E_UPSTREAM);

const EVENING_CRON = "0 18 * * 1-5";
const INTRADAY_CRON = "0 0-17,19-23 * * 1-5";

/** One step's failure is logged and never skips the next. */
const attempt = async (label: string, step: () => Promise<void>): Promise<void> => {
  try {
    await step();
  } catch (cause) {
    console.error(`Scheduled step ${label} failed`, cause);
  }
};

/** TanStack Start answers requests; the Cron Triggers in wrangler.jsonc run the evening price and rate refresh and the hourly intraday prices, then finish paused instrument lookups. `waitUntil` keeps the Worker alive for the chain. */
export default {
  // Only the request: Workers would pass `env` second, where TanStack expects its own options. Bindings come via `cloudflare:workers`.
  fetch: (request) => handler.fetch(request),
  scheduled(event, _env, ctx) {
    const prices =
      event.cron === INTRADAY_CRON
        ? async () => {
            await refreshIntraday(db, new Date(event.scheduledTime));
          }
        : () => runScheduledRefresh(db);
    ctx.waitUntil(
      (async () => {
        await attempt("prices", prices);
        await attempt("lookups", async () => {
          // The model is asked only once a day, on the evening run.
          const deps = event.cron === EVENING_CRON ? pageDeps() : null;
          await resolvePending(db, fetch, undefined, deps ?? undefined);
        });
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
