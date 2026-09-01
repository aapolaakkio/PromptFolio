import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";

import { db } from "../../../../server/db/index.ts";
import { runScheduledRefresh } from "../../../../server/prices/refresh.ts";

/**
 * The nightly price and rate refresh, as something to call rather than something
 * the process schedules for itself.
 *
 * An in-process timer only runs while the server does, restarts its own clock on
 * every deploy, and fires twice if the app is ever run as two processes. A cron
 * outside the app -- the host's, the platform's -- has none of those problems and
 * can be seen to have run.
 *
 * The secret is the whole authorisation: this writes prices, so an unset one
 * refuses every call rather than leaving the endpoint open.
 */
const authorised = (request: Request): boolean => {
  const secret = env.CRON_SECRET;
  if (secret === undefined || secret === "") return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
};

export const Route = createFileRoute("/api/cron/refresh")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!authorised(request)) {
          return Response.json({ error: "Ei oikeuksia" }, { status: 401 });
        }
        await runScheduledRefresh(db);
        return Response.json({ ok: true });
      },
    },
  },
});
