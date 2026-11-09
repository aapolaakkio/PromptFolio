import { desc, eq } from "drizzle-orm";

import type { Currency } from "../../core/money.ts";
import type { ChatClient } from "../chat/runner.ts";
import type { Db } from "../db/index.ts";
import { instruments, pageRecipes, prices } from "../db/schema.ts";
import { HttpError } from "../errors.ts";
import { checkPage } from "../prices/page.ts";
import type { PageRecipe } from "../prices/page-recipe.ts";
import { recordPoints } from "../prices/record.ts";
import type { FetchedPrice, FetchImpl } from "../prices/types.ts";

/** What a caller may set on a new instrument, already validated. */
export type NewInstrument = {
  readonly isin?: string | undefined;
  readonly ticker: string | null;
  readonly name: string;
  readonly kind: "stock" | "etf" | "fund" | "cash";
  readonly currency: Currency;
  readonly priceSource: "yahoo" | "page" | "manual";
  readonly sourceKey?: string | undefined;
  /** "pending" for one added while its lookup is still owed; "ok" otherwise. */
  readonly lookupStatus?: "ok" | "pending" | "attention" | undefined;
};

/**
 * Instruments are shared reference data across the family instance -- every
 * household member's transactions can reference the same Nokia share -- so they
 * are readable and creatable by any signed-in user. Only ledger rows are scoped
 * to their owner.
 */
export const listInstruments = async (db: Db) => await db.select().from(instruments).all();

/**
 * Registers an instrument, refusing one that is already there.
 *
 * Matched on ISIN when there is one and on name when there is not, because a
 * manual holding (a delisted share, a temporary line from a corporate action)
 * has no ISIN any registry will give up -- and inventing one would corrupt the
 * identifier every broker's rows join on.
 */
const refuseDuplicate = async (db: Db, body: NewInstrument): Promise<void> => {
  const isin = body.isin ?? null;
  if (isin !== null) {
    const existing = await db.select().from(instruments).where(eq(instruments.isin, isin)).get();
    if (existing) throw new HttpError(409, `ISIN ${isin} on jo lisätty`);
  } else {
    const existing = await db
      .select()
      .from(instruments)
      .where(eq(instruments.name, body.name))
      .get();
    if (existing) throw new HttpError(409, `Arvopaperi ${body.name} on jo lisätty`);
  }
};

export const addInstrument = async (db: Db, body: NewInstrument) => {
  await refuseDuplicate(db, body);
  const isin = body.isin ?? null;
  const sourceKey = body.sourceKey?.trim() || isin || body.name;
  return db
    .insert(instruments)
    .values({ ...body, isin, sourceKey })
    .returning()
    .get();
};

/** What may be corrected on an instrument after it was added. */
export type InstrumentFix = {
  readonly currency: Currency;
  readonly priceSource: NewInstrument["priceSource"];
  readonly sourceKey: string;
};

/**
 * Corrects how an instrument is priced: its quotation currency, its price
 * source and that source's code. Shared reference data, so any signed-in
 * member may correct it, as any may add one.
 *
 * A changed currency drops the instrument's stored prices: they were fetched
 * and checked against the old currency, and the next refresh fetches them in
 * the right one. Transactions are untouched -- their unit prices are read in
 * the instrument's currency, which is exactly what the correction fixes.
 */
export const updateInstrument = async (db: Db, id: number, fix: InstrumentFix) => {
  const existing = await db.select().from(instruments).where(eq(instruments.id, id)).get();
  if (existing === undefined) throw new HttpError(404, "Arvopaperia ei löytynyt");
  const sourceKey = fix.sourceKey.trim();
  if (fix.priceSource !== "manual" && sourceKey === "") {
    throw new HttpError(400, "Lähdetunnus vaaditaan, kun hintalähde hakee hinnat automaattisesti");
  }
  if (existing.currency !== fix.currency) {
    await db.delete(prices).where(eq(prices.instrumentId, id)).run();
  }
  const updated = await db
    .update(instruments)
    .set({
      currency: fix.currency,
      priceSource: fix.priceSource,
      sourceKey: sourceKey === "" ? (existing.isin ?? existing.name) : sourceKey,
      lookupStatus: "ok",
    })
    .where(eq(instruments.id, id))
    .returning()
    .get();
  if (updated === undefined) throw new HttpError(404, "Arvopaperia ei löytynyt");
  return updated;
};

/** What checking a typed page needs; injected so tests reach neither network nor model. */
export type PageDeps = {
  readonly fetchImpl: FetchImpl;
  readonly client: ChatClient;
  readonly today: string;
};

export type SavedPage = {
  readonly instrument: typeof instruments.$inferSelect;
  readonly price: FetchedPrice;
};

const saveRecipeAndPrice = async (
  db: Db,
  instrument: typeof instruments.$inferSelect,
  recipe: PageRecipe,
  price: FetchedPrice,
): Promise<void> => {
  const text = JSON.stringify(recipe);
  await db
    .insert(pageRecipes)
    .values({ instrumentId: instrument.id, recipe: text, askedAt: Date.now() })
    .onConflictDoUpdate({
      target: pageRecipes.instrumentId,
      set: { recipe: text, askedAt: Date.now() },
    })
    .run();
  await recordPoints(db, instrument, [price]);
};

/** Registers a page instrument, but only once the page has been read and verified. */
export const addPageInstrument = async (
  db: Db,
  body: NewInstrument,
  deps: PageDeps,
): Promise<SavedPage> => {
  await refuseDuplicate(db, body);
  const checked = await checkPage(
    body.sourceKey ?? "",
    {
      identity: body.isin ?? body.name,
      currency: body.currency,
      referenceMinor: null,
      today: deps.today,
    },
    deps.fetchImpl,
    deps.client,
  );
  if ("error" in checked) throw new HttpError(400, checked.error);
  const instrument = await addInstrument(db, body);
  await saveRecipeAndPrice(db, instrument, checked.recipe, checked.price);
  return { instrument, price: checked.price };
};

/** Points an instrument at a page: verified first, then saved with its new recipe. */
export const updatePageInstrument = async (
  db: Db,
  id: number,
  fix: InstrumentFix,
  deps: PageDeps,
): Promise<SavedPage> => {
  const existing = await db.select().from(instruments).where(eq(instruments.id, id)).get();
  if (existing === undefined) throw new HttpError(404, "Arvopaperia ei löytynyt");
  // A changed currency drops the stored prices, so none is a reference then.
  const latest =
    existing.currency === fix.currency
      ? await db
          .select({ close: prices.close })
          .from(prices)
          .where(eq(prices.instrumentId, id))
          .orderBy(desc(prices.date))
          .limit(1)
          .get()
      : undefined;
  const checked = await checkPage(
    fix.sourceKey.trim(),
    {
      identity: existing.isin ?? existing.name,
      currency: fix.currency,
      referenceMinor: latest?.close ?? null,
      today: deps.today,
    },
    deps.fetchImpl,
    deps.client,
  );
  if ("error" in checked) throw new HttpError(400, checked.error);
  const instrument = await updateInstrument(db, id, fix);
  await saveRecipeAndPrice(db, instrument, checked.recipe, checked.price);
  return { instrument, price: checked.price };
};
