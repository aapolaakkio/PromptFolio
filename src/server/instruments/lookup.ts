import { z } from "zod";

import { parseCurrency, type Currency } from "../../core/money";
import { figiLookup, type InstrumentKind } from "./openfigi";
import { resolveOpSlug } from "./op-slug";

/**
 * Yahoo's search, verified 2026-08-28 (fixtures/yahoo-search-*.json):
 * `FI0009000681 -> NOKIA.HE` and `IE00B4L5Y983 -> IWDA.L`, and -- checked
 * live against four real OP funds -- Finnish non-listed funds too, under
 * synthetic `0P...` symbols (`FI4000261128 -> 0P0001BP5K.F`, whose chart
 * endpoint returns daily NAV in EUR, running roughly a day or two behind
 * op.fi's own page). An ISIN it has never seen returns an empty `quotes`
 * array. This is the only checked source that yields the ticker the price
 * fetcher needs, which is why it decides the price source; the security's
 * *kind* comes from OpenFIGI, since the search result does not carry one.
 */
const SearchResponse = z.object({
  quotes: z.array(z.object({ symbol: z.string().min(1) })),
});

const ChartMeta = z.object({
  chart: z.object({
    result: z.array(z.object({ meta: z.object({ currency: z.string() }) })).min(1),
  }),
});

export type InstrumentLookup = {
  /** Null when no registry recognised the ISIN at all. */
  readonly kind: InstrumentKind | null;
  /** The registry's own name for the security, for the user to sanity-check against the broker's. */
  readonly name: string | null;
  readonly priceSource: "yahoo" | "op_fund" | null;
  readonly sourceKey: string | null;
  /**
   * The ISIN, which for an OP paste import is discovered here rather than
   * typed: OP's transaction view carries no ISIN column at all.
   */
  readonly isin: string | null;
  /**
   * The currency of the *listing* that was matched, which is not necessarily
   * the currency of the holding: one ISIN trades on several venues in
   * different currencies (IE00B4L5Y983 is USD in London, EUR in Amsterdam).
   * The instrument's currency comes from the broker's own row; this exists
   * only so the form can point out that the two disagree.
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
 * type. Resolution has two independent halves, because no single free source
 * covers both: OpenFIGI answers *what* the security is, and Yahoo answers
 * *where its price comes from*. When Yahoo has no match and the security is a
 * fund -- or when there is no ISIN to search with at all, which is what OP's
 * own paste import always looks like -- OP's fund page is tried by slug and
 * confirmed against the page before being used.
 *
 * Every leg fails soft. A lookup that resolves nothing returns nulls, and the
 * form falls back to being typed in by hand -- an unresolved instrument is a
 * mild inconvenience, a wrongly resolved one silently prices the wrong
 * security.
 */
export const lookupInstrument = async (
  isin: string | null,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<InstrumentLookup> => {
  const figi = isin === null ? null : await settle(figiLookup(isin, fetchImpl));
  const yahoo = isin === null ? null : await settle(yahooSymbol(isin, fetchImpl));

  if (yahoo !== null) {
    return {
      kind: figi?.kind ?? "stock",
      name: figi?.name ?? null,
      priceSource: "yahoo",
      sourceKey: yahoo,
      isin,
      listingCurrency: await settle(listingCurrency(yahoo, fetchImpl)),
    };
  }

  // Yahoo had no unambiguous match. If this is a fund -- or if nothing
  // recognised the ISIN, which is also what OP's ISIN-less paste import
  // looks like -- OP's own fund page is the remaining candidate.
  const fund = figi === null || figi.kind === "fund";
  if (!fund) return { ...NOTHING, kind: figi.kind, name: figi.name, isin };

  const op = await settle(resolveOpSlug(name, isin, fetchImpl));
  if (op === null) return { ...NOTHING, kind: figi?.kind ?? null, name: figi?.name ?? null, isin };

  return {
    kind: "fund",
    name: figi?.name ?? null,
    priceSource: "op_fund",
    sourceKey: op.slug,
    isin: op.isin,
    listingCurrency: null,
  };
};

/** A failed leg is an absent answer, never a failed lookup. */
const settle = async <T>(work: Promise<T>): Promise<T | null> => {
  try {
    return await work;
  } catch {
    return null;
  }
};

/** The single unambiguous Yahoo symbol for an ISIN, or null. */
const yahooSymbol = async (isin: string, fetchImpl: typeof fetch): Promise<string | null> => {
  const response = await fetchImpl(
    `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
      isin,
    )}&quotesCount=5&newsCount=0`,
  );
  if (!response.ok) return null;
  const parsed = SearchResponse.safeParse(await response.json());
  if (!parsed.success) return null;
  // Several matches would mean choosing a venue on the user's behalf -- the
  // one guess that silently prices the wrong listing -- so ambiguity falls
  // back to the form exactly like no match at all.
  return parsed.data.quotes.length === 1 ? parsed.data.quotes[0]!.symbol : null;
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
