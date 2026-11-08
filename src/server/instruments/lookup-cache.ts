import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Currency } from "../../core/money.ts";
import type { Db } from "../db/index.ts";
import { instrumentLookups } from "../db/schema.ts";
import type { FetchImpl } from "../prices/types.ts";
import { gatedFetch } from "../prices/yahoo-gate.ts";
import { lookupInstrument, type InstrumentLookup } from "./lookup.ts";

/** "Nothing found" may be a listing Yahoo gains later, so it is asked again. */
const FORM_RETRY_MS = 7 * 24 * 60 * 60_000;

const StoredLookup = z.object({
  kind: z.enum(["stock", "etf", "fund"]).nullable(),
  name: z.string().nullable(),
  priceSource: z.enum(["yahoo", "op_fund"]).nullable(),
  sourceKey: z.string().nullable(),
  isin: z.string().nullable(),
  listingCurrency: z.string().nullable(),
  outcome: z.enum(["found", "form", "pending"]),
  formReason: z.enum(["nothing", "currency", "name"]).nullable(),
});

export const lookupKey = (isin: string | null, name: string): string =>
  isin ?? `name:${name.trim().toLowerCase()}`;

/** A row of an older shape fails the parse and is a miss, never a wrong answer. */
const readCached = async (db: Db, key: string, now: number): Promise<InstrumentLookup | null> => {
  const row = await db.select().from(instrumentLookups).where(eq(instrumentLookups.key, key)).get();
  if (!row || row.outcome === "pending") return null;
  if (row.outcome === "form" && now - row.checkedAt.getTime() > FORM_RETRY_MS) return null;
  try {
    const parsed = StoredLookup.safeParse(JSON.parse(row.result));
    // SAFETY: the stored currency was written from a Currency by this module.
    return parsed.success ? (parsed.data as InstrumentLookup) : null;
  } catch {
    return null;
  }
};

export const rememberedLookup = async (
  db: Db,
  isin: string | null,
  name: string,
  currency: Currency | null,
  fetchImpl: FetchImpl,
  now: () => number = Date.now,
  quoteSpacingMs?: number,
): Promise<InstrumentLookup> => {
  const key = lookupKey(isin, name);
  const cached = await readCached(db, key, now());
  if (cached) return cached;

  const result = await lookupInstrument(
    isin,
    name,
    currency,
    gatedFetch(db, fetchImpl, now),
    quoteSpacingMs,
  );
  const checkedAt = new Date(now());
  await db
    .insert(instrumentLookups)
    .values({ key, outcome: result.outcome, result: JSON.stringify(result), checkedAt })
    .onConflictDoUpdate({
      target: instrumentLookups.key,
      set: { outcome: result.outcome, result: JSON.stringify(result), checkedAt },
    });
  return result;
};
