import { eq } from "drizzle-orm";

import { parseCurrency, parseMoney } from "../../core/money.ts";
import type { Db } from "../db/index.ts";
import { instruments } from "../db/schema.ts";
import { HttpError } from "../errors.ts";
import { helsinkiToday } from "../summary/helsinki.ts";
import { requirePositiveMinor, type FetchedPrice, type PriceSource } from "./types.ts";
import { writePrices } from "./write.ts";

/** The owner's today is Helsinki's, which runs ahead of UTC from 21:00 or 22:00 UTC. */
export const assertNotFuture = (date: string, now: Date = new Date()): void => {
  if (date > helsinkiToday(now)) {
    throw new HttpError(400, "The date is in the future");
  }
};

/** Records a person-typed price. Parsed in the instrument's currency, not the ledger's: reading a dollar quote as euros would misvalue the holding unnoticed. */
export const recordManualPrice = async (
  db: Db,
  input: { readonly instrumentId: number; readonly date: string; readonly price: string },
) => {
  assertNotFuture(input.date);
  const instrument = await db
    .select()
    .from(instruments)
    .where(eq(instruments.id, input.instrumentId))
    .get();
  if (!instrument) throw new HttpError(404, "Instrument not found");

  const currency = parseCurrency(instrument.currency);
  let minor: bigint;
  try {
    minor = parseMoney(input.price, currency).minor;
  } catch {
    throw new HttpError(400, "The price is not a valid decimal number");
  }

  let closeMinor: number;
  try {
    closeMinor = requirePositiveMinor(Number(minor), "manually entered price");
  } catch (cause) {
    throw new HttpError(400, cause instanceof Error ? cause.message : "The price is invalid");
  }

  // Skips the plausibility guard: a human fix must not be rejected, or need a multi-day re-baseline streak.
  const outcome = await writePrices(
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

export const MANUAL: PriceSource = {
  id: "manual",
  async fetch(): Promise<FetchedPrice[]> {
    return [];
  },
};
