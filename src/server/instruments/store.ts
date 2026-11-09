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

type NewInstrument = {
  readonly isin?: string | undefined;
  readonly ticker: string | null;
  readonly name: string;
  readonly kind: "stock" | "etf" | "fund" | "cash";
  readonly currency: Currency;
  readonly priceSource: "yahoo" | "page" | "manual";
  readonly sourceKey?: string | undefined;
  readonly lookupStatus?: "ok" | "pending" | "attention" | undefined;
};

// Instruments are shared reference data across the household: any signed-in user may read and create them; only ledger rows are owner-scoped.
export const listInstruments = async (db: Db) => await db.select().from(instruments).all();

/** Registers an instrument, refusing a duplicate: matched on ISIN, else name, since a manual holding has no ISIN and inventing one would corrupt the key brokers join on. */
const refuseDuplicate = async (db: Db, body: NewInstrument): Promise<void> => {
  const isin = body.isin ?? null;
  if (isin !== null) {
    const existing = await db.select().from(instruments).where(eq(instruments.isin, isin)).get();
    if (existing) throw new HttpError(409, `ISIN ${isin} has already been added`);
  } else {
    const existing = await db
      .select()
      .from(instruments)
      .where(eq(instruments.name, body.name))
      .get();
    if (existing) throw new HttpError(409, `Instrument ${body.name} has already been added`);
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

type InstrumentFix = {
  readonly currency: Currency;
  readonly priceSource: NewInstrument["priceSource"];
  readonly sourceKey: string;
};

/** Corrects quotation currency, price source and code (shared data, so any member may). A changed currency drops stored prices, which were checked against the old one; transactions are untouched. */
export const updateInstrument = async (db: Db, id: number, fix: InstrumentFix) => {
  const existing = await db.select().from(instruments).where(eq(instruments.id, id)).get();
  if (existing === undefined) throw new HttpError(404, "Instrument not found");
  const sourceKey = fix.sourceKey.trim();
  if (fix.priceSource !== "manual" && sourceKey === "") {
    throw new HttpError(
      400,
      "A source code is required when the price source fetches prices automatically",
    );
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
  if (updated === undefined) throw new HttpError(404, "Instrument not found");
  return updated;
};

export type PageDeps = {
  readonly fetchImpl: FetchImpl;
  readonly client: ChatClient;
  readonly today: string;
};

type SavedPage = {
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

export const updatePageInstrument = async (
  db: Db,
  id: number,
  fix: InstrumentFix,
  deps: PageDeps,
): Promise<SavedPage> => {
  const existing = await db.select().from(instruments).where(eq(instruments.id, id)).get();
  if (existing === undefined) throw new HttpError(404, "Instrument not found");
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
