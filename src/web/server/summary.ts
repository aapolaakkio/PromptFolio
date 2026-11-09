import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { db } from "../../server/db/index.ts";
import { getWeeklySummary } from "../../server/summary/service.ts";
import { authed, readable } from "./guard.ts";

/** POST because it may spend a model call: a refresh is refused by the server unless a day has passed. */
export const getSummary = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(z.object({ refresh: z.boolean().optional() }))
  .handler(({ data, context }) =>
    readable(() => getWeeklySummary(db, context.userId, { refresh: data.refresh === true })),
  );
