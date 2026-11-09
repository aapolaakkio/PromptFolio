import { z } from "zod";

import { parseCurrency } from "../../core/money.ts";
import {
  requireOk,
  requirePositiveMinor,
  toMinor,
  type FetchArgs,
  type FetchedPrice,
  type PriceSource,
} from "./types.ts";

// Shape (fixtures/yahoo-nokia.json): `chart.result[0]` with `meta.currency`, a `timestamp` epoch-second array
// and `indicators.quote[0].close` (same length, `null` for a day with no trade).
// Unverified against a live response: `period1`/`period2` bounds, and `meta.currency` for non-EUR/USD
// securities, so `parseCurrency` accepts any ISO 4217 shape.
// A window with no trading (weekend, holiday, unpublished NAV) returns `meta` alone: not a failure, and requiring the fields logged one per instrument every weekend.
const ChartResponse = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          meta: z.object({ currency: z.string() }),
          timestamp: z.array(z.number()).optional(),
          // `quote` is `[{}]` for a window with no bars, so `close` is optional.
          indicators: z
            .object({
              quote: z.array(z.object({ close: z.array(z.number().nullable()).optional() })).min(1),
            })
            .optional(),
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
    const closes = result.indicators?.quote[0]?.close;
    if (result.timestamp === undefined || closes === undefined) return [];

    return result.timestamp.flatMap((seconds, index) => {
      const close = closes[index];
      if (close === null || close === undefined) return [];
      const date = new Date(seconds * 1000).toISOString().slice(0, 10);
      const closeMinor = requirePositiveMinor(toMinor(close), `Yahoo ${sourceKey} ${date}`);
      return [{ date, closeMinor, currency }];
    });
  },
};
