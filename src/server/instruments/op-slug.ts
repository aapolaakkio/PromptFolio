/**
 * OP publishes no ISIN search, and its all-funds listing page is
 * client-rendered (fetched 2026-08-28: 159 kB of HTML containing neither an
 * ISIN nor a fund slug). What *is* fetchable without a session is each fund's
 * own page, whose URL slug is a predictable slugification of the fund's name:
 * `OP-Maailma Indeksi A` -> `op-maailma-indeksi`, verified live for
 * op-maailma-indeksi, op-suomi-indeksi, op-amerikka-indeksi and op-ilmasto.
 *
 * A guessed slug is never trusted on its own. The page carries the fund's
 * ISIN in its buy link (`osta-rahastoa?isin=FI4000261128`) and its name in
 * `<title>`, and `resolveOpSlug` only returns a slug whose page proves it is
 * the right fund -- by ISIN when one is known, by name otherwise. A wrong
 * guess therefore yields `null` and the manual form, never a plausible-looking
 * instrument pointed at some other fund's NAV.
 */
const PAGE_ISIN = /osta-rahastoa\?isin=([A-Z]{2}[A-Z0-9]{9}\d)/;
const PAGE_TITLE = /<title>([^<]*)<\/title>/;

/** Lowercased, punctuation-stripped, single-spaced -- for comparing names. */
const normalise = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9åäö]+/g, " ")
    .trim();

/**
 * A fund name minus its share-class suffix: OP's page covers the fund, while
 * the broker's row names a class (`OP-MAAILMA INDEKSI A`). A trailing single
 * letter, or a trailing `(kasvu)`/`(tuotto)` word, is dropped.
 */
export const stripShareClass = (name: string): string =>
  normalise(name)
    .replace(/\b(kasvu|tuotto|acc|dist)\b\s*$/, "")
    .replace(/\s+[a-z]$/, "")
    .trim();

/** The slug OP's own URLs use for a fund of this name. */
export const opSlugFor = (name: string): string => stripShareClass(name).replace(/\s+/g, "-");

export type OpSlugMatch = { readonly slug: string; readonly isin: string; readonly name: string };

/**
 * Confirms a guessed OP slug against the live page, returning it only when the
 * page proves it is the fund asked for. `isin` is the ISIN already known for
 * this holding, or `null` for OP's own paste import, which carries none -- in
 * which case the page's ISIN is harvested and the *name* has to carry the
 * proof instead.
 */
export const resolveOpSlug = async (
  name: string,
  isin: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<OpSlugMatch | null> => {
  const slug = opSlugFor(name);
  if (slug === "") return null;

  const response = await fetchImpl(
    `https://www.op.fi/henkiloasiakkaat/saastot-ja-sijoitukset/rahastot/kaikki-rahastot/${encodeURIComponent(
      slug,
    )}`,
  );
  if (!response.ok) return null;
  const html = await response.text();

  const pageIsin = PAGE_ISIN.exec(html)?.[1];
  if (pageIsin === undefined) return null;
  if (isin !== null) {
    return pageIsin === isin ? { slug, isin: pageIsin, name } : null;
  }

  // No ISIN to check against, so the page's own title has to establish that
  // this is the fund the row named -- not merely a page that exists.
  const title = PAGE_TITLE.exec(html)?.[1];
  if (title === undefined) return null;
  return normalise(title).startsWith(stripShareClass(name)) ? { slug, isin: pageIsin, name } : null;
};
