import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";

import { db } from "../../../../server/db/index.ts";
import { runScheduledRefresh } from "../../../../server/prices/refresh.ts";

/** Nightly price and rate refresh as a callable endpoint: an external cron avoids in-process timer problems (deploy resets, double firing). The secret is the whole authorisation; unset refuses every call. */
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
          return Response.json({ error: "Not authorised" }, { status: 401 });
        }
        await runScheduledRefresh(db);
        return Response.json({ ok: true });
      },
    },
  },
});
