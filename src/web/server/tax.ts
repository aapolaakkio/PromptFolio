import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { getDb } from "../../server/db/index.ts";
import { taxYearFor, taxYearsFor } from "../../server/tax.ts";
import { authed, readable } from "./guard.ts";

const { db } = getDb();

const Year = z
  .number()
  .int()
  .min(1990, "Verovuosi on virheellinen")
  .max(2100, "Verovuosi on virheellinen");

/** One tax year: realised gains both permitted ways, dividends, OST withdrawals. */
export const getTaxYear = createServerFn()
  .middleware([authed])
  .validator(z.object({ year: Year }))
  .handler(({ data, context }) => readable(() => taxYearFor(db, context.userId, data.year)));

/** The years the ledger has anything to report for. */
export const getTaxYears = createServerFn()
  .middleware([authed])
  .handler(({ context }) => taxYearsFor(db, context.userId));
