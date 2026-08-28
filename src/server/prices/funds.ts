import { z } from "zod";

import { parseCurrency, parseMoney } from "../../core/money";
import {
  requireOk,
  requirePositiveMinor,
  inRange,
  type FetchArgs,
  type FetchedPrice,
  type PriceSource,
} from "./types";

/**
 * ## What the brief guessed, and what is actually true
 *
 * The brief guessed a `GET /api/2/instruments/historical/prices/{isin}`
 * JSON endpoint. That endpoint exists but requires a logged-in session --
 * fetched live without cookies it returns `401 {"code":"NEXT_INVALID_SESSION"}`
 * (verified 2026-08-27 against both `/api/2/instruments/historical/prices/SE0005993102`
 * and `/api/2/main_search`). It is not usable by an unauthenticated server job.
 *
 * What *does* work without any session: each fund's own public detail page
 * (`https://www.nordnet.fi/rahastot/lista/{slug}`, e.g.
 * `nordnet-suomi-indeksi-eur-a401761d`) is server-rendered and embeds the
 * fund's current NAV directly in the HTML, inside a
 * `window.__initialState__="{...escaped JSON...}"` blob assigned in a
 * `<script>` tag. Verified 2026-08-27 by fetching both
 * `nordnet-suomi-indeksi-eur-a401761d` (SE0005993102, EUR) and
 * `nordnet-sverige-index-sek-aa7a9014` (SE0002756973, **SEK** -- exactly
 * the non-EUR holding this task calls out) and finding, in both, a
 * `"instrument":{...,"isin":"...","orderBook":{"id":"...","currency":"..."}}`
 * object immediately followed by `"navInfo":{"latestNav":{"date":"...",
 * "value":...},"previousNav":{...}}`. See fixtures/nordnet-fund-suomi.html
 * and fixtures/nordnet-fund-sverige.html for the real (trimmed) bytes.
 *
 * `sourceKey` is that page slug, not the ISIN -- the slug is what the URL
 * needs, and there is no unauthenticated way to resolve an ISIN to its
 * slug (the search endpoint is behind the same session wall).
 *
 * **Real, verified limitation, not a guess:** the embedded state carries
 * only `latestNav` and `previousNav` -- two NAV points, not a history. A
 * `from`/`to` range wider than that just yields fewer (possibly zero)
 * points; there is no way to backfill further back through this endpoint
 * without the authenticated session. Confirmed by grepping the full
 * ~1.8 MB fetched page for `priceHistory`/`chartData`/`series`-shaped keys
 * carrying more than these two dates -- none exist. A daily refresh job
 * (out of this task's scope) can still accumulate history over time by
 * calling this every day and keeping what it already has.
 *
 * **Why regex, not `JSON.parse`:** `window.__initialState__` is the
 * entire app's client-hydration state (~1.2 MB for a single fund page),
 * not just this fund's data, and is not close to worth parsing whole to
 * reach five values. The compound shape matched below --
 * `"orderBook":{"id":...,"currency":...}` immediately followed by
 * `"navInfo":{"latestNav":...,"previousNav":...}` -- was confirmed to
 * appear (identically, twice) on both real pages fetched, and did not
 * appear anywhere else on either page (the page's other fund mentions, a
 * "related funds" rail, use a flat `"orderBookId":"..."` string with no
 * adjacent `navInfo`, a different, non-matching shape). The captured
 * `orderBook` id's leading segment is additionally checked against
 * `sourceKey`'s own trailing segment before trusting the match, so a
 * future page carrying more than one instance of this compound shape
 * fails loudly instead of silently returning a different fund's price.
 */
const NORDNET_FUND_PATTERN =
  /\\"orderBook\\":\{\\"id\\":\\"([a-z0-9-]+)\\",\\"currency\\":\\"([A-Z]{3})\\"\}[\s\S]*?\\"navInfo\\":\{[\s\S]*?\\"latestNav\\":\{\\"date\\":\\"(\d{4}-\d{2}-\d{2})\\",\\"value\\":([\d.]+)\}[\s\S]*?\\"previousNav\\":\{\\"date\\":\\"(\d{4}-\d{2}-\d{2})\\",\\"value\\":([\d.]+)\}/;

const NordnetMatch = z.object({
  id: z.string().min(1),
  currency: z.string().regex(/^[A-Z]{3}$/),
  latestDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  latestValue: z.string().regex(/^\d+(\.\d+)?$/),
  previousDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  previousValue: z.string().regex(/^\d+(\.\d+)?$/),
});

export const NORDNET_FUND: PriceSource = {
  id: "nordnet_fund",
  async fetch({ sourceKey, from, to, fetchImpl = fetch }: FetchArgs): Promise<FetchedPrice[]> {
    const url = `https://www.nordnet.fi/rahastot/lista/${encodeURIComponent(sourceKey)}`;
    const response = await requireOk(await fetchImpl(url), `Nordnet ${sourceKey}`);
    const html = await response.text();

    const match = NORDNET_FUND_PATTERN.exec(html);
    if (match === null) {
      throw new Error(`nordnet_fund: NAV-tietoa ei löytynyt sivulta (${sourceKey})`);
    }
    const parsed = NordnetMatch.parse({
      id: match[1],
      currency: match[2],
      latestDate: match[3],
      latestValue: match[4],
      previousDate: match[5],
      previousValue: match[6],
    });

    const slugSuffix = sourceKey.split("-").pop() ?? sourceKey;
    if (!parsed.id.startsWith(slugSuffix)) {
      throw new Error(
        `nordnet_fund: sivulta löytyi NAV-tieto, joka ei vastaa pyydettyä rahastoa (${sourceKey})`,
      );
    }

    const currency = parseCurrency(parsed.currency);
    const points: FetchedPrice[] = [
      {
        date: parsed.latestDate,
        closeMinor: requirePositiveMinor(
          Number(parseMoney(parsed.latestValue, currency).minor),
          `nordnet_fund ${sourceKey} ${parsed.latestDate}`,
        ),
        currency,
      },
      {
        date: parsed.previousDate,
        closeMinor: requirePositiveMinor(
          Number(parseMoney(parsed.previousValue, currency).minor),
          `nordnet_fund ${sourceKey} ${parsed.previousDate}`,
        ),
        currency,
      },
    ];

    return points.filter((point) => inRange(point.date, from, to));
  },
};

/**
 * Verified 2026-08-27 against the real, unauthenticated page
 * `https://www.op.fi/henkiloasiakkaat/saastot-ja-sijoitukset/rahastot/kaikki-rahastot/op-maailma-indeksi`.
 * This is plain server-rendered Liferay-portal HTML (no client-side
 * rendering involved -- unlike the brief's guessed `data-nav="..."`
 * attribute, which does not exist anywhere on the page): the fact sheet
 * renders a definition list with `<dt>Osuuden arvo (26.08.)</dt><dd>283,60
 * EUR</dd>` -- the unit's NAV, its as-of date (day.month., no year, in
 * OP's Finnish locale), and its currency. See
 * fixtures/op-maailma-indeksi.html for the real (trimmed) bytes; the
 * fixture file is named after the actual fund, not the brief's guessed
 * "op-suomi" (OP-Maailma Indeksi is a world-equity index fund, not a
 * Finland one).
 *
 * The NAV date has no year, so one is inferred from `to` (the request's
 * own reference date): if the parsed day/month would fall *after* `to`,
 * it must belong to the previous year (the only way OP's "as of" date can
 * be later than the date being requested is a year boundary -- e.g.
 * requesting on 2 Jan while the page still shows 31.12.). This has not
 * been observed against a real December/January page load; it is a
 * documented inference, not a guess dressed up as a fact.
 *
 * `sourceKey` is the URL's final path segment (here, `op-maailma-indeksi`).
 */
const OP_NAV_PATTERN =
  /<dt>Osuuden arvo \((\d{2})\.(\d{2})\.\)<\/dt>\s*<dd>([\d\s.,]+)\s*([A-Z]{3})<\/dd>/;

const OpMatch = z.object({
  day: z.string().regex(/^\d{2}$/),
  month: z.string().regex(/^\d{2}$/),
  value: z.string().min(1),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

/** See `OP_NAV_PATTERN`'s comment for why the NAV date carries no year. */
const inferNavYear = (day: number, month: number, referenceIso: string): number => {
  const reference = new Date(`${referenceIso}T00:00:00Z`);
  const referenceYear = reference.getUTCFullYear();
  const candidate = new Date(Date.UTC(referenceYear, month - 1, day));
  const oneDayMs = 24 * 60 * 60 * 1000;
  return candidate.getTime() > reference.getTime() + oneDayMs ? referenceYear - 1 : referenceYear;
};

export const OP_FUND: PriceSource = {
  id: "op_fund",
  async fetch({ sourceKey, from, to, fetchImpl = fetch }: FetchArgs): Promise<FetchedPrice[]> {
    const url = `https://www.op.fi/henkiloasiakkaat/saastot-ja-sijoitukset/rahastot/kaikki-rahastot/${encodeURIComponent(
      sourceKey,
    )}`;
    const response = await requireOk(await fetchImpl(url), `OP ${sourceKey}`);
    const html = await response.text();

    const match = OP_NAV_PATTERN.exec(html);
    if (match === null) {
      throw new Error(`op_fund: NAV-arvoa ei löytynyt sivulta (${sourceKey})`);
    }
    const parsed = OpMatch.parse({
      day: match[1],
      month: match[2],
      value: match[3],
      currency: match[4],
    });

    const year = inferNavYear(Number(parsed.day), Number(parsed.month), to);
    const date = `${year}-${parsed.month}-${parsed.day}`;
    const currency = parseCurrency(parsed.currency);
    const { minor } = parseMoney(parsed.value, currency);
    const closeMinor = requirePositiveMinor(Number(minor), `op_fund ${sourceKey} ${date}`);

    const point: FetchedPrice = { date, closeMinor, currency };
    return inRange(point.date, from, to) ? [point] : [];
  },
};

export const MANUAL: PriceSource = {
  id: "manual",
  async fetch(): Promise<FetchedPrice[]> {
    return [];
  },
};
