import { eq } from "drizzle-orm";

import { parseCurrency, parseMoney } from "../../core/money.ts";
import type { getDb } from "../db/index.ts";
import { instruments } from "../db/schema.ts";
import { HttpError } from "../errors.ts";
import { requirePositiveMinor } from "./types.ts";
import { writePrices } from "./write.ts";

type Db = ReturnType<typeof getDb>["db"];

/**
 * Records a price a person typed, for a holding nothing can fetch.
 *
 * The price is parsed in the *instrument's* currency, not the ledger's: a
 * US-listed share is quoted in dollars, and reading its price as euros would
 * value the whole holding wrong without anything looking odd.
 */
export const recordManualPrice = (
  db: Db,
  input: { readonly instrumentId: number; readonly date: string; readonly price: string },
) => {
  const instrument = db
    .select()
    .from(instruments)
    .where(eq(instruments.id, input.instrumentId))
    .get();
  if (!instrument) throw new HttpError(404, "Arvopaperia ei löydy");

  const currency = parseCurrency(instrument.currency);
  let minor: bigint;
  try {
    minor = parseMoney(input.price, currency).minor;
  } catch {
    throw new HttpError(400, "Hinta ei ole kelvollinen desimaaliluku");
  }

  let closeMinor: number;
  try {
    closeMinor = requirePositiveMinor(Number(minor), "käsin syötetty hinta");
  } catch (cause) {
    throw new HttpError(400, cause instanceof Error ? cause.message : "Hinta on virheellinen");
  }

  // skipPlausibilityCheck: true -- see write.ts's `acceptUnconditionally` doc
  // for why a human-entered correction must bypass the scraper-plumbing
  // plausibility guard and its multi-day re-baseline streak, rather than risk a
  // legitimate fix being silently (or repeatedly) rejected.
  const outcome = writePrices(
    db,
    instrument.id,
    "manual",
    [{ date: input.date, closeMinor, currency }],
    {
      skipPlausibilityCheck: true,
    },
  );

  return { written: outcome.written };
};
