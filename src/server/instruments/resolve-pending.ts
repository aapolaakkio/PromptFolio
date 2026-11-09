import { and, asc, eq, isNotNull } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { instruments, pageRecipes, transactions } from "../db/schema.ts";
import type { FetchImpl } from "../prices/types.ts";
import type { PageDeps } from "./find-page.ts";
import type { InstrumentLookup } from "./lookup.ts";
import { yahooPausedUntil } from "../prices/yahoo-gate.ts";
import { rememberedLookup } from "./lookup-cache.ts";

type Pending = typeof instruments.$inferSelect;

const stillPending = (id: number) =>
  and(eq(instruments.id, id), eq(instruments.lookupStatus, "pending"));

/** A listing in another currency than the holding's is for the owner to decide. */
const sameCurrency = (row: Pending, found: InstrumentLookup): boolean =>
  found.listingCurrency === null || found.listingCurrency === row.currency;

/** True when the late answer was written: the row was still pending. */
const applyFound = async (db: Db, row: Pending, found: InstrumentLookup): Promise<boolean> => {
  if (found.priceSource === null || found.sourceKey === null) return false;
  const written = await db
    .update(instruments)
    .set({
      priceSource: found.priceSource,
      sourceKey: found.sourceKey,
      kind: found.kind ?? row.kind,
      lookupStatus: "ok",
    })
    .where(stillPending(row.id))
    .returning({ id: instruments.id })
    .all();
  if (written.length === 0) return false;
  if (found.priceSource === "page" && found.pageRecipe !== null) {
    await db
      .insert(pageRecipes)
      .values({
        instrumentId: row.id,
        recipe: JSON.stringify(found.pageRecipe),
        askedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: pageRecipes.instrumentId,
        set: { recipe: JSON.stringify(found.pageRecipe), askedAt: Date.now() },
      })
      .run();
  }
  return true;
};

/** The first buy's unit price: what a found page's price must be plausible against. */
const firstBuyPrice = async (db: Db, instrumentId: number): Promise<number | null> =>
  (
    await db
      .select({ unitPrice: transactions.unitPrice })
      .from(transactions)
      .where(
        and(
          eq(transactions.instrumentId, instrumentId),
          eq(transactions.type, "BUY"),
          isNotNull(transactions.unitPrice),
        ),
      )
      .orderBy(asc(transactions.tradeDate), asc(transactions.id))
      .limit(1)
      .get()
  )?.unitPrice ?? null;

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
 * While Yahoo is paused nothing is asked and rows stay pending. A found listing in another currency than the holding's goes to attention. Only rows still
 * pending are written, so a correction made in Muokkaa meanwhile wins.
 */
export const resolvePending = async (
  db: Db,
  fetchImpl: FetchImpl = fetch,
  quoteSpacingMs?: number,
  page?: PageDeps,
): Promise<{ resolved: number; attention: number }> => {
  if ((await yahooPausedUntil(db)) !== null) return { resolved: 0, attention: 0 };
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
        page === undefined
          ? undefined
          : { ...page, referenceMinor: await firstBuyPrice(db, row.id) },
      );
      if (lookup.outcome === "found" && sameCurrency(row, lookup)) {
        if (await applyFound(db, row, lookup)) resolved += 1;
      } else if (lookup.outcome !== "pending" && (await markAttention(db, row.id))) {
        attention += 1;
      }
    } catch (cause) {
      console.error(`Arvopaperin ${row.isin ?? row.name} haku epäonnistui`, cause);
    }
  }
  return { resolved, attention };
};
