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

const GONE_STATUSES = new Set([404, 410]);

export class PageGoneError extends Error {}

const PRIVATE_SUFFIXES = [".local", ".internal", ".localhost"];

/**
 * True for an address the app may fetch for a model or a stored recipe: an
 * https page on a public-looking host name, on the default port. IP literals,
 * `localhost`, single-label names and the private suffixes are refused, so a
 * page URL from the web cannot point the Worker at something internal.
 */
export const isPublicPageUrl = (url: string): boolean => {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.port !== "") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  // URL normalises every IPv4 spelling (0x7f.1, 2130706433) to dotted decimal.
  if (host.startsWith("[") || /^[\d.]+$/.test(host)) return false;
  if (host === "localhost" || !host.includes(".")) return false;
  return !PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
};

const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * One plain GET of a price page; a 404 or 410 is a page gone, not a hiccup.
 * Redirects are followed by hand, at most MAX_REDIRECTS, and only to an
 * address `isPublicPageUrl` accepts. Anything else fails as a transient error.
 */
export const fetchPage = async (
  url: string,
  fetchImpl: FetchImpl,
  redirectsLeft: number = MAX_REDIRECTS,
): Promise<string> => {
  if (!isPublicPageUrl(url)) throw new Error("Sivun osoite ei ole julkinen https-osoite");
  const response = await fetchImpl(url, { redirect: "manual" });
  if (REDIRECT_STATUSES.has(response.status)) {
    const location = response.headers.get("location");
    if (location === null || redirectsLeft === 0 || !URL.canParse(location, url)) {
      throw new Error("Sivu ohjasi eteenpäin liian monta kertaa tai ilman osoitetta");
    }
    return await fetchPage(new URL(location, url).toString(), fetchImpl, redirectsLeft - 1);
  }
  if (GONE_STATUSES.has(response.status)) {
    throw new PageGoneError(`Sivu vastasi ${response.status}: osoite ei enää toimi`);
  }
  return await (await requireOk(response, "Sivu")).text();
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
  if (!isPublicPageUrl(instrument.sourceKey)) {
    await logAttempt(db, {
      source: SOURCE,
      instrumentId: instrument.id,
      ok: false,
      message: "Sivun osoite ei ole julkinen https-osoite, sitä ei haettu",
    });
    await setStatus(db, instrument, "attention");
    return "attention";
  }

  let html: string;
  try {
    html = await fetchPage(instrument.sourceKey, opts.fetchImpl);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Tuntematon virhe";
    await logAttempt(db, { source: SOURCE, instrumentId: instrument.id, ok: false, message });
    if (cause instanceof PageGoneError) {
      await setStatus(db, instrument, "attention");
      return "attention";
    }
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
    await setStatus(db, instrument, "attention");
    return "attention";
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

/**
 * A typed page address, checked before anything is saved: fetched once and
 * read by a recipe the model writes and the app verifies. A refusal or a
 * failed fetch comes back as a Finnish reason.
 */
export const checkPage = async (
  url: string,
  expect: PageExpect,
  fetchImpl: FetchImpl,
  client: ChatClient,
): Promise<{ recipe: PageRecipe; price: FetchedPrice } | { error: string }> => {
  if (!isPublicPageUrl(url)) {
    return { error: "Osoitteen on oltava julkinen https-osoite ilman porttia tai IP-osoitetta." };
  }
  let html: string;
  try {
    html = await fetchPage(url, fetchImpl);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "Tuntematon virhe";
    return { error: `Sivua ei voitu hakea: ${reason}` };
  }
  return await writePageRecipe(html, expect, client);
};
