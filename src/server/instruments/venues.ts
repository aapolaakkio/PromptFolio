/**
 * Yahoo's exchange suffixes for the venues OpenFIGI reports, so a security's
 * listing on a *particular* market can be probed by symbol. This exists
 * because one ISIN trades in several currencies -- IE00B4L5Y983 is USD as
 * `IWDA.L` and EUR as `IWDA.AS` -- and the holding's own currency is the only
 * thing that says which listing its prices should come from.
 *
 * Verified live 2026-08-28: `NA` -> `IWDA.AS` (EUR, AMS), `LN` -> `IWDA.L`
 * (USD, LSE), `GR` -> `EUNL.DE` (EUR, GER), `FH` -> `NOKIA.HE` (EUR, HEL).
 * The rest are Yahoo's long-standing suffixes for those markets but were not
 * each confirmed against a live response; an entry that turns out to be wrong
 * costs nothing beyond a probe that finds no data, since every candidate is
 * confirmed by fetching it before it is ever used.
 */
const YAHOO_SUFFIX_BY_EXCHANGE = new Map<string, string>([
  ["NA", ".AS"], // Euronext Amsterdam
  ["LN", ".L"], // London
  ["GR", ".DE"], // Xetra
  ["IM", ".MI"], // Milan
  ["FP", ".PA"], // Euronext Paris
  ["SS", ".ST"], // Stockholm
  ["FH", ".HE"], // Helsinki
  ["DC", ".CO"], // Copenhagen
  ["NO", ".OL"], // Oslo
  ["SM", ".MC"], // Madrid
  ["SW", ".SW"], // SIX Swiss
  ["EO", ".AS"], // Euronext, unspecified venue -- Amsterdam is its usual home
]);

export type Venue = { readonly ticker: string; readonly exchCode: string };

/**
 * Candidate Yahoo symbols for a security, in probe order: whatever Yahoo's own
 * search returned first (it is a direct hit, not a construction), then one per
 * known venue. Deduplicated, and capped -- a security can list on 100+ venues,
 * and probing them all would turn one registration into a minute of requests.
 */
export const candidateSymbols = (
  searchHits: readonly string[],
  venues: readonly Venue[],
  limit = 8,
): string[] => {
  const seen = new Set<string>(searchHits);
  const candidates = [...searchHits];
  for (const venue of venues) {
    const suffix = YAHOO_SUFFIX_BY_EXCHANGE.get(venue.exchCode);
    if (suffix === undefined) continue;
    const symbol = `${venue.ticker}${suffix}`;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    candidates.push(symbol);
    if (candidates.length >= limit) break;
  }
  return candidates.slice(0, limit);
};
