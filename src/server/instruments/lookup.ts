import { z } from "zod";

import type { Currency } from "../../core/money.ts";
import type { ChatClient } from "../chat/runner.ts";
import { fetchPage } from "../prices/page.ts";
import { writePageRecipe } from "../prices/page-ask.ts";
import type { PageRecipe } from "../prices/page-recipe.ts";
import { fetchLatestQuotes } from "../prices/yahoo-batch.ts";
import { YahooPausedError } from "../prices/yahoo-gate.ts";
import type { PageFinder } from "./find-page.ts";
import { figiLookup, type InstrumentKind } from "./openfigi.ts";
import { resolveOpSlug } from "./op-slug.ts";
import { candidateSymbols } from "./venues.ts";

/**
 * Yahoo's search. Finnish non-listed funds resolve too, under synthetic `0P...`
 * symbols whose chart endpoint serves daily NAV about a day behind the
 * provider's own page. An unknown ISIN returns an empty array.
 */
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

/**
 * A placeholder quote for a venue Yahoo has no real ticker on: the symbol is the
 * ISIN plus an exchange suffix. It carries nothing, and counting it as a
 * candidate made every ETF that has one look ambiguous. Matched by shape, since
 * nothing says one venue is the only one this happens for.
 */
const isIsinPlaceholder = (symbol: string, isin: string): boolean => symbol.startsWith(isin);

/** Yahoo's own quoteType, used for kind only when OpenFIGI had no answer. */
const kindFromQuoteType = (quoteType: string | undefined): InstrumentKind | null => {
  if (quoteType === "ETF") return "etf";
  if (quoteType === "EQUITY") return "stock";
  if (quoteType === "MUTUALFUND") return "fund";
  return null;
};

export type InstrumentLookup = {
  /** Null when no registry recognised the ISIN at all. */
  readonly kind: InstrumentKind | null;
  /** The registry's own name, for the user to sanity-check against the broker's. */
  readonly name: string | null;
  readonly priceSource: "yahoo" | "op_fund" | "page" | null;
  /** The page's URL when `priceSource` is "page". */
  readonly sourceKey: string | null;
  /**
   * The ISIN, which for an OP paste import is discovered here rather than
   * typed: OP's transaction view carries no ISIN column at all.
   */
  readonly isin: string | null;
  /**
   * The currency of the listing that was chosen. Equal to the holding's own
   * currency whenever a listing in that currency could be found; when it is
   * not, it is the currency of the only listing there was, and the review
   * screen says so rather than letting a USD listing price a EUR holding
   * silently.
   */
  readonly listingCurrency: Currency | null;
  /**
   * "found": use it as is. "form": the user has to look (see `formReason`).
   * "pending": Yahoo is paused, so nothing is known yet and nothing was
   * wrongly reported as missing.
   */
  readonly outcome: "found" | "form" | "pending";
  /** Why the form is needed; null unless `outcome` is "form". */
  readonly formReason: "nothing" | "currency" | "name" | null;
  /** The recipe that read the page's price, when `priceSource` is "page". */
  readonly pageRecipe: PageRecipe | null;
};

/** The web search and the model that verifies what it finds; see `lookupInstrument`. */
export type PageLookup = {
  readonly find: PageFinder;
  readonly client: ChatClient;
  /** What the page's price must be plausible against: a hostile page can name any number. */
  readonly referenceMinor: number | null;
};

/** What the finder answered, once: the page itself is kept so it is fetched once too. */
type Hit = { readonly url: string; readonly isin: string | null; readonly html: string | null };

/** The finder or the model threw: nothing is known yet, which is not "nothing found". */
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
 * Fills in what the unknown-instrument form would otherwise make the user type.
 *
 * Two halves, because no free source covers both: OpenFIGI says what the security
 * is and where it lists, Yahoo says what it costs under a symbol per venue.
 *
 * `currency` decides rather than hints. One ISIN trades on several venues in
 * different currencies, so the listing matching the holding is the only right one.
 *
 * Every leg fails soft: an unresolved instrument is an inconvenience, a wrongly
 * resolved one silently prices the wrong security.
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

/**
 * `hit` is undefined until the finder has been asked, and then whatever it
 * answered, null included: one web search per instrument, however the
 * lookup recurses.
 */
const lookupWith = async (
  ask: Ask,
  isin: string | null,
  hit: Hit | null | undefined,
): Promise<InstrumentLookup> => {
  try {
    // OP's paste import carries no ISIN column, so the fund's own page is the
    // only way to learn its ISIN. It is learned first, so a Yahoo pause after
    // that still reports the ISIN rather than losing it.
    if (isin === null) {
      const discovered = await settle(resolveOpSlug(ask.name, null, ask.fetchImpl));
      if (discovered !== null) return await lookupWith(ask, discovered.isin, hit);
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

/**
 * An ISIN a found page shows is still only the page's word: a page about a
 * sister fund shows that fund's ISIN, and Yahoo would then price the wrong
 * security without complaint. It is used only when OpenFIGI's name for it
 * agrees with the row's; otherwise the owner looks.
 */
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

/** A share Yahoo cannot price has no NAV page to find; a fund or an unknown might. */
const mayHavePage = (resolved: Resolved): boolean =>
  resolved.kind === null || resolved.kind === "fund";

/** Asks the finder and fetches what it names. A page that will not load has no html. */
const findPage = async (ask: Ask, page: PageLookup, isin: string | null): Promise<Hit | null> => {
  let found: Awaited<ReturnType<PageFinder>>;
  try {
    found = await page.find({ isin, name: ask.name, currency: ask.currency });
  } catch (cause) {
    console.error(`Sivun haku arvopaperille ${isin ?? ask.name} epäonnistui`, cause);
    throw new PagePendingError("Sivun haku epäonnistui", { cause });
  }
  if (found === null) return null;
  return { ...found, html: await settle(fetchPage(found.url, ask.fetchImpl)) };
};

const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * OpenFIGI and Yahoo found nothing to price. A page the web search finds is
 * used only once a recipe the app runs has read a plausible, current price
 * for this ISIN (or name) and currency off it.
 */
const viaFoundPage = async (
  ask: Ask,
  page: PageLookup,
  resolved: Resolved,
  isin: string | null,
  known: Hit | null | undefined,
): Promise<InstrumentLookup> => {
  // ponytail: with no currency there is nothing to check the page's against.
  if (ask.currency === null) return classify(resolved, ask.currency);
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
    console.error(`Sivun ${hit.url} kuvauksen kysyminen epäonnistui`, cause);
    throw new PagePendingError("Mallia ei tavoitettu", { cause });
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

/**
 * Sends to the form: nothing found; the only listing is in another currency
 * than the holding; or a row with no ISIN that a name search resolved (an OP
 * fund resolved through its page has its ISIN by then, so it is not one).
 */
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
  // An OP fund's ISIN was already learned from its page by now, so the
  // ordinary path below prices it from Yahoo when Yahoo has it (it does have
  // OP's funds, under 0P... symbols) and only falls back to OP's page when it
  // does not.
  if (isin === null) {
    // A share has no such page. Yahoo can still be searched by name, which
    // fills in everything except the ISIN -- no free source checked maps a
    // ticker or a name back to one, so that field stays typed by hand.
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

  // Nothing Yahoo can price. A fund may still have its own provider page.
  if (kind !== null && kind !== "fund") {
    return { ...NOTHING, kind, name: figi?.name ?? null, isin };
  }
  return await viaOpFundPage(name, isin, figi?.name ?? null, fetchImpl);
};

/**
 * OP's own fund page, reached by slugifying the fund's name and confirmed
 * against the page before use. This is the only path for OP's paste import,
 * whose rows carry no ISIN at all -- the page is where the ISIN comes from.
 */
const viaOpFundPage = async (
  name: string,
  isin: string | null,
  registryName: string | null,
  fetchImpl: typeof fetch,
): Promise<Resolved> => {
  const op = await settle(resolveOpSlug(name, isin, fetchImpl));
  if (op === null) return { ...NOTHING, name: registryName, isin };
  return {
    kind: "fund",
    name: registryName,
    priceSource: "op_fund",
    sourceKey: op.slug,
    isin: op.isin,
    listingCurrency: null,
    pageRecipe: null,
  };
};

type Listing = { readonly symbol: string; readonly currency: Currency };

/**
 * The first candidate quoted in the holding's currency, or the first that exists
 * at all, so the form can offer something and flag the mismatch. All candidates
 * are probed in order and probing stops at the first match, so the home listing costs one request.
 */
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

/**
 * Resolves a holding that has no ISIN at all -- OP's paste never carries one --
 * from its name alone. Deliberately strict about what counts as a match: a
 * name search will happily return a different company, and registering the
 * wrong security silently prices a holding from something the user does not
 * own. The registry name has to actually look like the name that was asked
 * for, and the listing still has to be the one quoted in the holding's own
 * currency.
 */
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

/**
 * The queries to try, in order. A broker prints the legal company form and
 * Yahoo's relevance ranking is thrown by it: searching a name with "OYJ" appended returns
 * seven German and American listings and not the Helsinki one at all, while
 * the bare name puts the Helsinki listing first. Verified against several Helsinki-listed shares, including
 * a Helsinki-listed share; the bare name is tried first for that reason, with the broker's
 * own spelling kept as a fallback for a name the stripping mangles.
 */
const searchTerms = (name: string): string[] => {
  const bare = name.replace(COMPANY_FORM, " ").replace(/\s+/g, " ").trim();
  return bare !== "" && bare.toLowerCase() !== name.toLowerCase() ? [bare, name] : [name];
};

/** The legal-form words a broker appends, which are noise to a name search. */
const COMPANY_FORM = /\b(oyj|oy|abp|plc|ab|asa|as|inc|corp|corporation|group|nv|sa)\b/gi;

/** Lowercased, punctuation-stripped, and without the company-form suffixes a broker prints. */
const normaliseName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9åäö]+/g, " ")
    .replace(/\b(oyj|oy|abp|plc|ab|asa|as|inc|corp|corporation|group|nv|sa)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * True when one name is the other's opening words. "NOKIA OYJ" matches "Nokia
 * Oyj"; it does not match "Nokian Renkaat", whose first word differs once the
 * company-form suffixes are gone.
 */
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

/** A failed leg is an absent answer, never a failed lookup. */
const settle = async <T>(work: Promise<T>): Promise<T | null> => {
  try {
    return await work;
  } catch (err) {
    if (err instanceof YahooPausedError) throw err;
    return null;
  }
};

type YahooHit = { readonly symbol: string; readonly quoteType: string | undefined };

/** Yahoo's own matches for an ISIN, placeholders removed. */
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
