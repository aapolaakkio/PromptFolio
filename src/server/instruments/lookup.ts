import { z } from "zod";

import type { Currency } from "../../core/money.ts";
import { fetchLatestQuotes } from "../prices/yahoo-batch.ts";
import { YahooPausedError } from "../prices/yahoo-gate.ts";
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
  readonly priceSource: "yahoo" | "op_fund" | null;
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
};

type Resolved = Omit<InstrumentLookup, "outcome" | "formReason">;

const NOTHING: Resolved = {
  kind: null,
  name: null,
  priceSource: null,
  sourceKey: null,
  isin: null,
  listingCurrency: null,
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
export const lookupInstrument = async (
  isin: string | null,
  name: string,
  currency: Currency | null,
  fetchImpl: typeof fetch = fetch,
  quoteSpacingMs?: number,
): Promise<InstrumentLookup> => {
  try {
    return classify(await resolve(isin, name, currency, fetchImpl, quoteSpacingMs), currency);
  } catch (err) {
    if (err instanceof YahooPausedError) {
      return { ...NOTHING, isin, outcome: "pending", formReason: null };
    }
    throw err;
  }
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
  // OP's paste import carries no ISIN column, so the fund's own page is the
  // only way to learn its ISIN. Once that is known there is nothing special
  // left about the holding: it goes through the ordinary path, which prices it
  // from Yahoo when Yahoo has it (it does have OP's funds, under 0P... symbols)
  // and only falls back to OP's page when it does not.
  if (isin === null) {
    // A fund resolves through OP's own page, which is where its ISIN comes
    // from; with that in hand it takes the ordinary path.
    const discovered = await settle(resolveOpSlug(name, null, fetchImpl));
    if (discovered !== null) {
      return await resolve(discovered.isin, name, currency, fetchImpl, quoteSpacingMs);
    }
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
  };
};

type Listing = { readonly symbol: string; readonly currency: Currency };

/**
 * The first candidate quoted in the holding's currency, or the first that exists
 * at all, so the form can offer something and flag the mismatch. All candidates
 * are quoted together in one call, in order.
 */
const pickListing = async (
  candidates: readonly string[],
  currency: Currency | null,
  fetchImpl: typeof fetch,
  quoteSpacingMs: number | undefined,
): Promise<Listing | null> => {
  const quotes = await fetchLatestQuotes(candidates, fetchImpl, quoteSpacingMs);
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
