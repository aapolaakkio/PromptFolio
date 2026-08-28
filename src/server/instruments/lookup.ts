import { z } from "zod";

import { parseCurrency, type Currency } from "../../core/money";
import { figiLookup, type InstrumentKind } from "./openfigi";
import { resolveOpSlug } from "./op-slug";
import { candidateSymbols } from "./venues";

/**
 * Yahoo's search, verified 2026-08-28 (fixtures/yahoo-search-*.json):
 * `FI0009000681 -> NOKIA.HE` and `IE00B4L5Y983 -> IWDA.L`, and -- checked
 * live against four real OP funds -- Finnish non-listed funds too, under
 * synthetic `0P...` symbols (`FI4000261128 -> 0P0001BP5K.F`, whose chart
 * endpoint returns daily NAV in EUR, roughly a day behind op.fi's own page).
 * An ISIN it has never seen returns an empty `quotes` array.
 */
const SearchResponse = z.object({
  quotes: z.array(z.object({ symbol: z.string().min(1), quoteType: z.string().optional() })),
});

const ChartMeta = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          meta: z.object({ currency: z.string(), instrumentType: z.string().optional() }),
        }),
      )
      .min(1),
  }),
});

/**
 * Yahoo returns a placeholder quote for a venue it has no real ticker on: the
 * "symbol" is the ISIN itself with an exchange suffix, e.g. `IE0002Y8CX98.SG`
 * alongside the genuine `EUDF.DE`. It carries no information, and treating it
 * as a candidate made every ETF that has one look ambiguous and fall through
 * to the manual form -- which is what happened to IE0002Y8CX98 and
 * IE000W8WMSL2. Matched by shape rather than by suffix, since nothing says
 * Stuttgart is the only venue Yahoo does this for.
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
};

const NOTHING: InstrumentLookup = {
  kind: null,
  name: null,
  priceSource: null,
  sourceKey: null,
  isin: null,
  listingCurrency: null,
};

/**
 * Fills in what the unknown-instrument form would otherwise make the user
 * type. Resolution has two halves, because no single free source covers both:
 * OpenFIGI answers *what* the security is and *where it lists*, and Yahoo
 * answers *what its price is* under a symbol per venue.
 *
 * `currency` is the holding's own currency, taken from the broker rows this
 * instrument appeared in. It is the deciding input, not a hint: one ISIN
 * trades on several venues in different currencies (IE00B4L5Y983 is USD in
 * London and EUR in Amsterdam), so the listing whose currency matches the
 * holding is the correct source and every other listing is the wrong one.
 *
 * Every leg fails soft. A lookup that resolves nothing returns nulls and the
 * form falls back to being typed in by hand -- an unresolved instrument is a
 * mild inconvenience, a wrongly resolved one silently prices the wrong
 * security.
 */
export const lookupInstrument = async (
  isin: string | null,
  name: string,
  currency: Currency | null,
  fetchImpl: typeof fetch = fetch,
): Promise<InstrumentLookup> => {
  if (isin === null) return await viaOpFundPage(name, null, null, fetchImpl);

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
): Promise<InstrumentLookup> => {
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
 * The listing to price this holding from: the first candidate quoted in the
 * holding's own currency, or -- when none is -- the first candidate that
 * exists at all, so the form can offer something and flag the mismatch rather
 * than showing an error and an empty form.
 *
 * Candidates are probed in order and the search stops at the first currency
 * match, so the common case (the home listing, first in the list) costs one
 * request.
 */
const pickListing = async (
  candidates: readonly string[],
  currency: Currency | null,
  fetchImpl: typeof fetch,
): Promise<Listing | null> => {
  let fallback: Listing | null = null;
  for (const symbol of candidates) {
    const quoted = await settle(listingCurrency(symbol, fetchImpl));
    if (quoted === null) continue;
    if (currency === null || quoted === currency) return { symbol, currency: quoted };
    fallback ??= { symbol, currency: quoted };
  }
  return fallback;
};

/** A failed leg is an absent answer, never a failed lookup. */
const settle = async <T>(work: Promise<T>): Promise<T | null> => {
  try {
    return await work;
  } catch {
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

const listingCurrency = async (
  symbol: string,
  fetchImpl: typeof fetch,
): Promise<Currency | null> => {
  const response = await fetchImpl(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol,
    )}?range=1d&interval=1d`,
  );
  if (!response.ok) return null;
  const parsed = ChartMeta.safeParse(await response.json());
  if (!parsed.success) return null;
  return parseCurrency(parsed.data.chart.result[0]!.meta.currency.toUpperCase());
};
