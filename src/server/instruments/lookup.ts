import { z } from "zod";

import type { Currency } from "../../core/money.ts";
import type { ChatClient } from "../chat/runner.ts";
import { isTransientFailure } from "../chat/transient.ts";
import { fetchPage } from "../prices/page.ts";
import { writePageRecipe } from "../prices/page-ask.ts";
import type { PageRecipe } from "../prices/page-recipe.ts";
import { fetchLatestQuotes } from "../prices/yahoo-batch.ts";
import { YahooPausedError } from "../prices/yahoo-gate.ts";
import type { PageFinder } from "./find-page.ts";
import { figiLookup, type InstrumentKind } from "./openfigi.ts";
import { candidateSymbols } from "./venues.ts";

// Finnish non-listed funds resolve under synthetic `0P...` symbols (daily NAV, about a day behind the provider's page).
const SearchResponse = z.object({
  quotes: z.array(
    z.object({
      symbol: z.string().min(1),
      quoteType: z.string().optional(),
      longname: z.string().optional(),
      shortname: z.string().optional(),
    }),
  ),
});

// Placeholder quote for a venue with no real ticker (ISIN plus exchange suffix); counting it made ETFs look ambiguous.
const isIsinPlaceholder = (symbol: string, isin: string): boolean => symbol.startsWith(isin);

const kindFromQuoteType = (quoteType: string | undefined): InstrumentKind | null => {
  if (quoteType === "ETF") return "etf";
  if (quoteType === "EQUITY") return "stock";
  if (quoteType === "MUTUALFUND") return "fund";
  return null;
};

export type InstrumentLookup = {
  readonly kind: InstrumentKind | null;
  readonly name: string | null;
  readonly priceSource: "yahoo" | "page" | null;
  readonly sourceKey: string | null;
  /** Discovered here for OP paste imports, which carry no ISIN column. */
  readonly isin: string | null;
  /** Equals the holding's currency when such a listing exists; otherwise the only listing's, and the review screen flags it. */
  readonly listingCurrency: Currency | null;
  /** "pending": Yahoo is paused or a transient failure hit, so nothing is known yet. */
  readonly outcome: "found" | "form" | "pending";
  readonly formReason: "nothing" | "currency" | "name" | null;
  readonly pageRecipe: PageRecipe | null;
};

export type PageLookup = {
  readonly find: PageFinder;
  readonly client: ChatClient;
  /** What the page's price must be plausible against: a hostile page can name any number. */
  readonly referenceMinor: number | null;
};

type Hit = { readonly url: string; readonly isin: string | null; readonly html: string | null };

/** A transient finder/model failure: nothing known yet, which is not "nothing found". */
class PagePendingError extends Error {}

type Resolved = Omit<InstrumentLookup, "outcome" | "formReason">;

const NOTHING: Resolved = {
  kind: null,
  name: null,
  priceSource: null,
  sourceKey: null,
  isin: null,
  listingCurrency: null,
  pageRecipe: null,
};

/**
 * Fills in what the unknown-instrument form would make the user type: OpenFIGI says what the
 * security is and where it lists, Yahoo prices it per venue. `currency` decides the listing,
 * since one ISIN trades in several currencies. Every leg fails soft: an unresolved instrument
 * is an inconvenience, a wrongly resolved one silently prices the wrong security.
 */
export const lookupInstrument = (
  isin: string | null,
  name: string,
  currency: Currency | null,
  fetchImpl: typeof fetch = fetch,
  quoteSpacingMs?: number,
  page?: PageLookup,
): Promise<InstrumentLookup> =>
  lookupWith({ name, currency, fetchImpl, quoteSpacingMs, page: page ?? null }, isin, undefined);

type Ask = {
  readonly name: string;
  readonly currency: Currency | null;
  readonly fetchImpl: typeof fetch;
  readonly quoteSpacingMs: number | undefined;
  readonly page: PageLookup | null;
};

// `hit` is undefined until the finder was asked, then its answer (null included): one web search per instrument.
const lookupWith = async (
  ask: Ask,
  isin: string | null,
  hit: Hit | null | undefined,
): Promise<InstrumentLookup> => {
  try {
    if (isin === null) {
      if (ask.page !== null && ask.currency !== null && hit === undefined) {
        const found = await findPage(ask, ask.page, null);
        // The finder's ISIN is only a claim until the page itself shows it.
        const shown =
          found !== null && found.isin !== null && found.html?.includes(found.isin) === true;
        if (shown) return await claimedIsin(ask, found.isin, found);
        return await resolveThenPage(ask, null, found === null ? null : { ...found, isin: null });
      }
    }
    return await resolveThenPage(ask, isin, hit);
  } catch (err) {
    if (err instanceof YahooPausedError || err instanceof PagePendingError) {
      return { ...NOTHING, isin, outcome: "pending", formReason: null };
    }
    throw err;
  }
};

// A page about a sister fund shows that fund's ISIN, so it is used only when OpenFIGI's name for it agrees with the row's.
const claimedIsin = async (ask: Ask, isin: string, hit: Hit): Promise<InstrumentLookup> => {
  // ponytail: OpenFIGI is asked again inside `resolve`; one extra request per claimed ISIN.
  const figi = await settle(figiLookup(isin, ask.fetchImpl));
  if (!namesAgree(ask.name, figi?.name ?? null)) {
    return { ...NOTHING, name: figi?.name ?? null, outcome: "form", formReason: "name" };
  }
  return await lookupWith(ask, isin, hit);
};

/** OpenFIGI and Yahoo first; a found page only when they have nothing to price. */
const resolveThenPage = async (
  ask: Ask,
  isin: string | null,
  hit: Hit | null | undefined,
): Promise<InstrumentLookup> => {
  const resolved = await resolve(isin, ask.name, ask.currency, ask.fetchImpl, ask.quoteSpacingMs);
  if (ask.page !== null && resolved.priceSource === null && mayHavePage(resolved)) {
    return await viaFoundPage(ask, ask.page, resolved, isin, hit);
  }
  return classify(resolved, ask.currency);
};

const mayHavePage = (resolved: Resolved): boolean =>
  resolved.kind === null || resolved.kind === "fund";

const findPage = async (ask: Ask, page: PageLookup, isin: string | null): Promise<Hit | null> => {
  let found: Awaited<ReturnType<PageFinder>>;
  try {
    found = await page.find({ isin, name: ask.name, currency: ask.currency });
  } catch (cause) {
    console.error(`Page lookup for instrument ${isin ?? ask.name} failed`, cause);
    if (!isTransientFailure(cause)) return null;
    throw new PagePendingError("Page lookup failed", { cause });
  }
  if (found === null) return null;
  return { ...found, html: await settle(fetchPage(found.url, ask.fetchImpl)) };
};

const today = (): string => new Date().toISOString().slice(0, 10);

// A found page is used only once a recipe has read a plausible, current price for this ISIN and currency off it.
const viaFoundPage = async (
  ask: Ask,
  page: PageLookup,
  resolved: Resolved,
  isin: string | null,
  known: Hit | null | undefined,
): Promise<InstrumentLookup> => {
  // ponytail: with no currency there is nothing to check the page's against.
  if (ask.currency === null) return classify(resolved, ask.currency);
  // ponytail: with no ISIN to find on the page, a name match is too weak to trust a recipe.
  if (isin === null) return classify(resolved, ask.currency);
  const hit = known === undefined ? await findPage(ask, page, isin) : known;
  if (hit === null || hit.html === null) return classify(resolved, ask.currency);

  let written: Awaited<ReturnType<typeof writePageRecipe>>;
  try {
    written = await writePageRecipe(
      hit.html,
      {
        identity: isin ?? ask.name,
        currency: ask.currency,
        referenceMinor: page.referenceMinor,
        today: today(),
      },
      page.client,
    );
  } catch (cause) {
    console.error(`Asking for a recipe for page ${hit.url} failed`, cause);
    if (!isTransientFailure(cause)) return classify(resolved, ask.currency);
    throw new PagePendingError("The model could not be reached", { cause });
  }
  if ("error" in written) return classify(resolved, ask.currency);
  return classify(
    {
      ...resolved,
      kind: resolved.kind ?? "fund",
      priceSource: "page",
      sourceKey: hit.url,
      isin,
      listingCurrency: ask.currency,
      pageRecipe: written.recipe,
    },
    ask.currency,
  );
};

/** Form when nothing was found, the only listing is in another currency, or the ISIN is missing. */
const classify = (resolved: Resolved, currency: Currency | null): InstrumentLookup => {
  if (resolved.priceSource === null) return { ...resolved, outcome: "form", formReason: "nothing" };
  if (resolved.isin === null) return { ...resolved, outcome: "form", formReason: "name" };
  if (
    currency !== null &&
    resolved.listingCurrency !== null &&
    resolved.listingCurrency !== currency
  ) {
    return { ...resolved, outcome: "form", formReason: "currency" };
  }
  return { ...resolved, outcome: "found", formReason: null };
};

const resolve = async (
  isin: string | null,
  name: string,
  currency: Currency | null,
  fetchImpl: typeof fetch,
  quoteSpacingMs: number | undefined,
): Promise<Resolved> => {
  if (isin === null) {
    // No free source maps a name back to an ISIN, so that field stays typed by hand.
    return await byName(name, currency, fetchImpl, quoteSpacingMs);
  }

  const figi = await settle(figiLookup(isin, fetchImpl));
  const hits = (await settle(yahooSearch(isin, fetchImpl))) ?? [];
  const kind = figi?.kind ?? kindFromQuoteType(hits[0]?.quoteType);

  const listing = await pickListing(
    candidateSymbols(
      hits.map((hit) => hit.symbol),
      figi?.venues ?? [],
    ),
    currency,
    fetchImpl,
    quoteSpacingMs,
  );
  if (listing !== null) {
    return {
      kind,
      name: figi?.name ?? null,
      priceSource: "yahoo",
      sourceKey: listing.symbol,
      isin,
      listingCurrency: listing.currency,
      pageRecipe: null,
    };
  }

  return { ...NOTHING, kind, name: figi?.name ?? null, isin };
};

type Listing = { readonly symbol: string; readonly currency: Currency };

/** First candidate in the holding's currency, else the first that exists (the form flags the mismatch). Probing stops at the first match. */
const pickListing = async (
  candidates: readonly string[],
  currency: Currency | null,
  fetchImpl: typeof fetch,
  quoteSpacingMs: number | undefined,
): Promise<Listing | null> => {
  const quotes = await fetchLatestQuotes(
    candidates,
    fetchImpl,
    quoteSpacingMs,
    (_symbol, price) => currency === null || price.currency === currency,
  );
  let fallback: Listing | null = null;
  for (const symbol of candidates) {
    const quoted = quotes.get(symbol)?.currency;
    if (quoted === undefined) continue;
    if (currency === null || quoted === currency) return { symbol, currency: quoted };
    fallback ??= { symbol, currency: quoted };
  }
  return fallback;
};

// Strict on purpose: a name search happily returns a different company, which would price the holding from something the user does not own.
const byName = async (
  name: string,
  currency: Currency | null,
  fetchImpl: typeof fetch,
  quoteSpacingMs: number | undefined,
): Promise<Resolved> => {
  const hits: NamedHit[] = [];
  const seen = new Set<string>();
  for (const term of searchTerms(name)) {
    for (const hit of (await settle(yahooSearchByName(term, fetchImpl))) ?? []) {
      if (seen.has(hit.symbol)) continue;
      seen.add(hit.symbol);
      hits.push(hit);
    }
  }
  const matching = hits.filter((hit) => namesAgree(name, hit.registryName));
  if (matching.length === 0) return NOTHING;

  const listing = await pickListing(
    matching.map((hit) => hit.symbol),
    currency,
    fetchImpl,
    quoteSpacingMs,
  );
  if (listing === null) return NOTHING;

  const chosen = matching.find((hit) => hit.symbol === listing.symbol);
  return {
    kind: kindFromQuoteType(chosen?.quoteType),
    name: chosen?.registryName ?? null,
    priceSource: "yahoo",
    sourceKey: listing.symbol,
    isin: null,
    listingCurrency: listing.currency,
    pageRecipe: null,
  };
};

// The broker's legal company form throws Yahoo's ranking (with "OYJ" the Helsinki listing can vanish), so the bare name goes first.
const searchTerms = (name: string): string[] => {
  const bare = name.replace(COMPANY_FORM, " ").replace(/\s+/g, " ").trim();
  return bare !== "" && bare.toLowerCase() !== name.toLowerCase() ? [bare, name] : [name];
};

const COMPANY_FORM = /\b(oyj|oy|abp|plc|ab|asa|as|inc|corp|corporation|group|nv|sa)\b/gi;

const normaliseName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9åäö]+/g, " ")
    .replace(/\b(oyj|oy|abp|plc|ab|asa|as|inc|corp|corporation|group|nv|sa)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** One name is the other's opening words: "NOKIA OYJ" matches "Nokia Oyj", not "Nokian Renkaat". */
const namesAgree = (asked: string, found: string | null): boolean => {
  if (found === null) return false;
  const a = normaliseName(asked);
  const b = normaliseName(found);
  if (a === "" || b === "") return false;
  return a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `);
};

type NamedHit = {
  readonly symbol: string;
  readonly quoteType: string | undefined;
  readonly registryName: string | null;
};

const yahooSearchByName = async (name: string, fetchImpl: typeof fetch): Promise<NamedHit[]> => {
  const response = await fetchImpl(
    `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
      name,
    )}&quotesCount=10&newsCount=0`,
  );
  if (!response.ok) return [];
  const parsed = SearchResponse.safeParse(await response.json());
  if (!parsed.success) return [];
  return parsed.data.quotes.map((quote) => ({
    symbol: quote.symbol,
    quoteType: quote.quoteType,
    registryName: quote.longname ?? quote.shortname ?? null,
  }));
};

const settle = async <T>(work: Promise<T>): Promise<T | null> => {
  try {
    return await work;
  } catch (err) {
    if (err instanceof YahooPausedError) throw err;
    return null;
  }
};

type YahooHit = { readonly symbol: string; readonly quoteType: string | undefined };

const yahooSearch = async (isin: string, fetchImpl: typeof fetch): Promise<YahooHit[]> => {
  const response = await fetchImpl(
    `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
      isin,
    )}&quotesCount=10&newsCount=0`,
  );
  if (!response.ok) return [];
  const parsed = SearchResponse.safeParse(await response.json());
  if (!parsed.success) return [];
  return parsed.data.quotes
    .filter((quote) => !isIsinPlaceholder(quote.symbol, isin))
    .map((quote) => ({ symbol: quote.symbol, quoteType: quote.quoteType }));
};
