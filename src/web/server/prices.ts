import { createServerFn } from "@tanstack/react-start";
import { PriceInput } from "../../server/action-inputs.ts";
import { db } from "../../server/db/index.ts";
import { recordManualPrice } from "../../server/prices/manual.ts";
import { runScheduledRefresh } from "../../server/prices/refresh.ts";
import { authed, readable } from "./guard.ts";

/** Records a price by hand for a holding no source can price (delisted share, unlisted fund). */
export const savePrice = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(PriceInput)
  .handler(({ data }) => readable(() => recordManualPrice(db, data)));

/** The weekday cron's refresh on demand; prices are household-shared, so any signed-in member may run it. */
// ponytail: no throttle; the button disables while a run is in flight. Add one
// if the price sources start refusing repeated runs.
export const refreshPricesNow = createServerFn({ method: "POST" })
  .middleware([authed])
  .handler(() => readable(() => runScheduledRefresh(db)));
