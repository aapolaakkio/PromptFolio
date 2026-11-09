import { and, eq } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { instruments, prices } from "../db/schema.ts";
import type { FetchImpl } from "../prices/types.ts";
import type { InstrumentLookup } from "./lookup.ts";
import { rememberedLookup } from "./lookup-cache.ts";

type Pending = typeof instruments.$inferSelect;

const stillPending = (id: number) =>
  and(eq(instruments.id, id), eq(instruments.lookupStatus, "pending"));

/** True when the late answer was written: the row was still pending. */
const applyFound = async (db: Db, row: Pending, found: InstrumentLookup): Promise<boolean> => {
  if (found.priceSource === null || found.sourceKey === null) return false;
  const currency = found.listingCurrency ?? row.currency;
  const written = await db
    .update(instruments)
    .set({
      priceSource: found.priceSource,
      sourceKey: found.sourceKey,
      currency,
      kind: found.kind ?? row.kind,
      lookupStatus: "ok",
    })
    .where(stillPending(row.id))
    .returning({ id: instruments.id })
    .all();
  if (written.length > 0 && currency !== row.currency) {
    await db.delete(prices).where(eq(prices.instrumentId, row.id)).run();
  }
  return written.length > 0;
};

const markAttention = async (db: Db, id: number): Promise<boolean> => {
  const written = await db
    .update(instruments)
    .set({ lookupStatus: "attention" })
    .where(stillPending(id))
    .returning({ id: instruments.id })
    .all();
  return written.length > 0;
};

/**
 * Finishes the lookups that were paused when an import added an instrument.
 * One Yahoo still has paused stays pending for the next run. Only rows still
 * pending are written, so a correction made in Muokkaa meanwhile wins.
 */
export const resolvePending = async (
  db: Db,
  fetchImpl: FetchImpl = fetch,
  quoteSpacingMs?: number,
): Promise<{ resolved: number; attention: number }> => {
  const pending = await db
    .select()
    .from(instruments)
    .where(eq(instruments.lookupStatus, "pending"))
    .all();
  let resolved = 0;
  let attention = 0;
  for (const row of pending) {
    try {
      const lookup = await rememberedLookup(
        db,
        row.isin,
        row.name,
        row.currency,
        fetchImpl,
        Date.now,
        quoteSpacingMs,
      );
      if (lookup.outcome === "found" && (await applyFound(db, row, lookup))) resolved += 1;
      else if (lookup.outcome === "form" && (await markAttention(db, row.id))) attention += 1;
    } catch (cause) {
      console.error(`Arvopaperin ${row.isin ?? row.name} haku epäonnistui`, cause);
    }
  }
  return { resolved, attention };
};
