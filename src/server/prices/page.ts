import { desc, eq } from "drizzle-orm";

import type { ChatClient } from "../chat/runner.ts";
import type { Db } from "../db/index.ts";
import { instruments, pageRecipes, prices } from "../db/schema.ts";
import {
  judgePageRead,
  PageRecipeSchema,
  runPageRecipe,
  type PageExpect,
  type PageRecipe,
} from "./page-recipe.ts";
import { writePageRecipe } from "./page-ask.ts";
import { logAttempt, recordPoints } from "./record.ts";
import { requireOk, type FetchImpl, type FetchedPrice } from "./types.ts";

export const PAGE_REASK_DAYS = 7;
export const PAGE_SPACING_MS = 2_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCE = "page";

type PageInstrument = typeof instruments.$inferSelect;
export type PageOutcome = "ok" | "failed" | "attention";

const storedRecipe = (text: string | null): PageRecipe | null => {
  if (text === null) return null;
  try {
    const parsed = PageRecipeSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const latestStoredPrice = async (db: Db, instrumentId: number): Promise<number | null> =>
  (
    await db
      .select({ close: prices.close })
      .from(prices)
      .where(eq(prices.instrumentId, instrumentId))
      .orderBy(desc(prices.date))
      .limit(1)
      .get()
  )?.close ?? null;

const setStatus = async (
  db: Db,
  instrument: PageInstrument,
  status: PageInstrument["lookupStatus"],
): Promise<void> => {
  if (instrument.lookupStatus === status) return;
  await db
    .update(instruments)
    .set({ lookupStatus: status })
    .where(eq(instruments.id, instrument.id))
    .run();
};

const saveAsk = async (
  db: Db,
  instrumentId: number,
  fields: { readonly askedAt: number; readonly recipe?: string },
): Promise<void> => {
  await db
    .insert(pageRecipes)
    .values({ instrumentId, askedAt: fields.askedAt, recipe: fields.recipe ?? null })
    .onConflictDoUpdate({ target: pageRecipes.instrumentId, set: fields })
    .run();
};

const write = async (db: Db, instrument: PageInstrument, price: FetchedPrice): Promise<boolean> => {
  const done = await recordPoints(db, instrument, [price]);
  if (done) await setStatus(db, instrument, "ok");
  return done;
};

const stillAttention = (instrument: PageInstrument): PageOutcome =>
  instrument.lookupStatus === "attention" ? "attention" : "failed";

const fetchPage = async (instrument: PageInstrument, fetchImpl: FetchImpl): Promise<string> => {
  const response = await requireOk(await fetchImpl(instrument.sourceKey), "Sivu");
  return await response.text();
};

/**
 * One page instrument's evening run: its stored recipe if that still reads the
 * page, otherwise one model ask per PAGE_REASK_DAYS.
 */
export const refreshPage = async (
  db: Db,
  instrument: PageInstrument,
  opts: {
    readonly fetchImpl: FetchImpl;
    readonly client: ChatClient | null;
    readonly today: string;
    readonly now: number;
  },
): Promise<PageOutcome> => {
  let html: string;
  try {
    html = await fetchPage(instrument, opts.fetchImpl);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Tuntematon virhe";
    await logAttempt(db, { source: SOURCE, instrumentId: instrument.id, ok: false, message });
    return stillAttention(instrument);
  }

  const identity = instrument.isin ?? instrument.name;
  const expect: PageExpect = {
    identity,
    currency: instrument.currency,
    referenceMinor: null,
    today: opts.today,
  };
  const row = await db
    .select()
    .from(pageRecipes)
    .where(eq(pageRecipes.instrumentId, instrument.id))
    .get();

  const recipe = storedRecipe(row?.recipe ?? null);
  if (recipe !== null) {
    const read = runPageRecipe(html, recipe, identity, opts.today);
    if (judgePageRead(read, expect).passed && read.price !== null) {
      return (await write(db, instrument, read.price)) ? "ok" : stillAttention(instrument);
    }
  }

  const askedAt = row?.askedAt ?? null;
  const due = askedAt === null || opts.now - askedAt >= PAGE_REASK_DAYS * DAY_MS;
  if (opts.client === null || !due) {
    await logAttempt(db, {
      source: SOURCE,
      instrumentId: instrument.id,
      ok: false,
      message: "Tallennettu kuvaus ei lukenut sivua, uutta ei kysytty",
    });
    return stillAttention(instrument);
  }

  await saveAsk(db, instrument.id, { askedAt: opts.now });
  const referenceMinor = await latestStoredPrice(db, instrument.id);
  const written = await writePageRecipe(html, { ...expect, referenceMinor }, opts.client);
  if ("error" in written) {
    await setStatus(db, instrument, "attention");
    await logAttempt(db, {
      source: SOURCE,
      instrumentId: instrument.id,
      ok: false,
      message: written.error,
    });
    return "attention";
  }
  await saveAsk(db, instrument.id, { askedAt: opts.now, recipe: JSON.stringify(written.recipe) });
  return (await write(db, instrument, written.price)) ? "ok" : stillAttention(instrument);
};
