import { eq, ne, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Currency } from "../../core/money.ts";
import type { Db } from "../db/index.ts";
import { instrumentLookups } from "../db/schema.ts";
import { PageRecipeSchema } from "../prices/page-recipe.ts";
import type { FetchImpl } from "../prices/types.ts";
import { gatedFetch } from "../prices/yahoo-gate.ts";
import { lookupInstrument, type InstrumentLookup, type PageLookup } from "./lookup.ts";

// "Nothing found" may become a listing later, and an unverifiable found page is "form" too, so both are re-asked after this.
const FORM_RETRY_MS = 7 * 24 * 60 * 60_000;

const StoredLookup = z.object({
  kind: z.enum(["stock", "etf", "fund"]).nullable(),
  name: z.string().nullable(),
  priceSource: z.enum(["yahoo", "page"]).nullable(),
  sourceKey: z.string().nullable(),
  isin: z.string().nullable(),
  listingCurrency: z.string().nullable(),
  outcome: z.enum(["found", "form", "pending"]),
  formReason: z.enum(["nothing", "currency", "name"]).nullable(),
  pageRecipe: PageRecipeSchema.nullable().default(null),
});

export const lookupKey = (isin: string | null, name: string): string =>
  isin ?? `name:${name.trim().toLowerCase()}`;

export const readStoredLookup = (stored: string): InstrumentLookup | null => {
  try {
    const parsed = StoredLookup.safeParse(JSON.parse(stored));
    // SAFETY: the stored currency was written from a Currency by this module.
    return parsed.success ? (parsed.data as InstrumentLookup) : null;
  } catch {
    return null;
  }
};

const readCached = async (db: Db, key: string, now: number): Promise<InstrumentLookup | null> => {
  const row = await db.select().from(instrumentLookups).where(eq(instrumentLookups.key, key)).get();
  if (!row || row.outcome === "pending") return null;
  if (row.outcome === "form" && now - row.checkedAt.getTime() > FORM_RETRY_MS) return null;
  return readStoredLookup(row.result);
};

const upsertLookup = async (
  db: Db,
  key: string,
  result: InstrumentLookup,
  checkedAt: Date,
  setWhere?: SQL,
): Promise<void> => {
  await db
    .insert(instrumentLookups)
    .values({ key, outcome: result.outcome, result: JSON.stringify(result), checkedAt })
    .onConflictDoUpdate({
      target: instrumentLookups.key,
      set: { outcome: result.outcome, result: JSON.stringify(result), checkedAt },
      setWhere,
    });
};

const storeLookup = (
  db: Db,
  key: string,
  result: InstrumentLookup,
  checkedAt: Date,
): Promise<void> => upsertLookup(db, key, result, checkedAt);

/** Remembers `result` unless a found entry exists: a name lookup never overrides one made from the ISIN. */
export const storeLookupUnlessFound = (
  db: Db,
  key: string,
  result: InstrumentLookup,
  checkedAt: Date,
): Promise<void> =>
  upsertLookup(db, key, result, checkedAt, ne(instrumentLookups.outcome, "found"));

export const rememberedLookup = async (
  db: Db,
  isin: string | null,
  name: string,
  currency: Currency | null,
  fetchImpl: FetchImpl,
  now: () => number = Date.now,
  quoteSpacingMs?: number,
  page?: PageLookup,
): Promise<InstrumentLookup> => {
  const key = lookupKey(isin, name);
  const cached = await readCached(db, key, now());
  if (cached) {
    if (
      cached.outcome === "found" &&
      currency !== null &&
      cached.listingCurrency !== null &&
      cached.listingCurrency !== currency
    ) {
      return { ...cached, outcome: "form", formReason: "currency" };
    }
    return cached;
  }

  const result = await lookupInstrument(
    isin,
    name,
    currency,
    gatedFetch(db, fetchImpl, now),
    quoteSpacingMs,
    page,
  );
  await storeLookup(db, key, result, new Date(now()));
  return result;
};
