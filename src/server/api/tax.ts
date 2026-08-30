import { z } from "zod";

import { requireUser } from "../auth-guard.ts";
import { getDb } from "../db/index.ts";
import { handle, HttpError, json } from "../http.ts";
import { taxYearFor, taxYearsFor } from "../tax.ts";

const { db } = getDb();

/**
 * A tax year, as a four-digit number.
 *
 * Bounded rather than merely numeric: the report walks five earlier years to
 * resolve carried losses, so a nonsensical year is work done for nothing, and
 * a caller asking for one has a bug worth being told about.
 */
const YearSchema = z.coerce
  .number()
  .int()
  .min(1990, "Verovuosi on virheellinen")
  .max(2100, "Verovuosi on virheellinen");

export const taxRoutes = {
  "/api/tax": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      const raw = new URL(request.url).searchParams.get("year");
      const parsed = YearSchema.safeParse(raw);
      if (!parsed.success) {
        throw new HttpError(400, parsed.error.issues[0]?.message ?? "Verovuosi on virheellinen");
      }
      return json(taxYearFor(db, userId, parsed.data));
    }),
  },
  "/api/tax/years": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      return json(taxYearsFor(db, userId));
    }),
  },
};
