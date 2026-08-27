import { z } from "zod";

import { parseCurrency } from "../../core/money";
import { requireOk, toMinor, type FetchArgs, type FetchedPrice, type PriceSource } from "./types";

/**
 * Verified 2026-08-27 by fetching
 * `https://query1.finance.yahoo.com/v8/finance/chart/NOKIA.HE?range=5d&interval=1d`
 * directly (no auth, no cookies) -- see fixtures/yahoo-nokia.json for the
 * recorded response. Shape matches the brief's guess exactly: a
 * `chart.result[0]` with `meta.currency`, a `timestamp` array (epoch
 * seconds) and `indicators.quote[0].close` (same length, `null` for a day
 * with no trade). Only the two things below were *not* verifiable from one
 * fetch and are handled defensively rather than assumed:
 *  - Which query parameters the endpoint accepts. `range=5d` (what the
 *    brief's fixture-recording step used) definitely works; `period1`/
 *    `period2` (epoch-second bounds, what this fetch actually sends so
 *    `from`/`to` are honoured) were not independently confirmed against a
 *    live response, since re-fetching for arbitrary ranges from within
 *    this task would touch the network beyond the one recorded fixture.
 *    They are Yahoo's long-documented public parameter names for this
 *    endpoint, not a guess invented here.
 *  - `meta.currency` for a security other than NOKIA.HE (an ETF's
 *    currency could be something other than EUR/USD). `parseCurrency`
 *    accepts any ISO 4217 shape, not just those two, so this is not
 *    artificially narrowed -- but no non-EUR-non-USD response was ever
 *    observed.
 */
const ChartResponse = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          meta: z.object({ currency: z.string() }),
          timestamp: z.array(z.number()),
          indicators: z.object({
            quote: z.array(z.object({ close: z.array(z.number().nullable()) })).min(1),
          }),
        }),
      )
      .min(1),
  }),
});

export const YAHOO: PriceSource = {
  id: "yahoo",
  async fetch({ sourceKey, from, to, fetchImpl = fetch }: FetchArgs): Promise<FetchedPrice[]> {
    const period1 = Math.floor(Date.parse(from) / 1000);
    const period2 = Math.floor(Date.parse(to) / 1000) + 86_400;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      sourceKey,
    )}?period1=${period1}&period2=${period2}&interval=1d`;

    const response = await requireOk(await fetchImpl(url), `Yahoo ${sourceKey}`);
    const payload = ChartResponse.parse(await response.json());
    const result = payload.chart.result[0]!;
    const currency = parseCurrency(result.meta.currency.toUpperCase());
    const closes = result.indicators.quote[0]!.close;

    return result.timestamp.flatMap((seconds, index) => {
      const close = closes[index];
      if (close === null || close === undefined) return [];
      return [
        {
          date: new Date(seconds * 1000).toISOString().slice(0, 10),
          closeMinor: toMinor(close),
          currency,
        },
      ];
    });
  },
};
