/**
 * Yahoo's exchange suffixes for the venues OpenFIGI reports, so a listing on a particular market can
 * be probed: one ISIN trades in several currencies (IE00B4L5Y983 is USD as `IWDA.L`, EUR as `IWDA.AS`)
 * and the holding's currency picks the listing. Live-verified: `NA`, `LN`, `GR`, `FH`; the rest are
 * Yahoo's usual suffixes, and a wrong one only costs a probe, since every candidate is fetched before use.
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

type Venue = { readonly ticker: string; readonly exchCode: string };

/** Candidate Yahoo symbols in probe order: Yahoo's own search hits first (direct, not constructed), then one per known venue; deduplicated and capped, as 100+ venues would be a minute of requests. */
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
