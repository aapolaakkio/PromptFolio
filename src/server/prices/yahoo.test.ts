import { readText } from "../files.ts";
import { expect, test } from "vitest";

import { parseCurrency } from "../../core/money.ts";
import { YAHOO } from "./yahoo.ts";

const fixture = (name: string) => readText(`${import.meta.dirname}/fixtures/${name}`);

/** Recorded 2026-08-27 from `query1.finance.yahoo.com/v8/finance/chart/NOKIA.HE?range=5d&interval=1d`. */
const stubFetch = async (): Promise<Response> =>
  new Response(await fixture("yahoo-nokia.json"), {
    headers: { "content-type": "application/json" },
  });

test("parses the real fixture into dated closes in minor units, currency observed from the response", async () => {
  const prices = await YAHOO.fetch({
    sourceKey: "NOKIA.HE",
    from: "2025-01-01",
    to: "2025-12-31",
    fetchImpl: stubFetch,
  });
  expect(prices.length).toBeGreaterThan(0);
  for (const point of prices) {
    expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isInteger(point.closeMinor)).toBe(true);
    expect(point.closeMinor).toBeGreaterThan(0);
    expect(point.currency).toBe(parseCurrency("EUR"));
  }
});

test("drops days whose close is null instead of emitting zero", async () => {
  const withGap = async (): Promise<Response> =>
    Response.json({
      chart: {
        result: [
          {
            meta: { currency: "EUR" },
            timestamp: [1735689600, 1735776000],
            indicators: { quote: [{ close: [4.15, null] }] },
          },
        ],
        error: null,
      },
    });
  const prices = await YAHOO.fetch({
    sourceKey: "X",
    from: "2025-01-01",
    to: "2025-01-02",
    fetchImpl: withGap,
  });
  expect(prices).toHaveLength(1);
  expect(prices[0]!.closeMinor).toBe(415);
});

test("carries a non-EUR/USD currency through rather than rejecting it", async () => {
  const sek = async (): Promise<Response> =>
    Response.json({
      chart: {
        result: [
          {
            meta: { currency: "SEK" },
            timestamp: [1735689600],
            indicators: { quote: [{ close: [123.45] }] },
          },
        ],
        error: null,
      },
    });
  const prices = await YAHOO.fetch({
    sourceKey: "X.ST",
    from: "2025-01-01",
    to: "2025-01-02",
    fetchImpl: sek,
  });
  expect(prices).toHaveLength(1);
  expect(prices[0]!.currency).toBe(parseCurrency("SEK"));
});

test("rejects an unparseable currency code loudly instead of guessing", async () => {
  const badCurrency = async (): Promise<Response> =>
    Response.json({
      chart: {
        result: [
          {
            meta: { currency: "not-a-currency" },
            timestamp: [1735689600],
            indicators: { quote: [{ close: [1] }] },
          },
        ],
        error: null,
      },
    });
  await expect(
    YAHOO.fetch({ sourceKey: "X", from: "2025-01-01", to: "2025-01-02", fetchImpl: badCurrency }),
  ).rejects.toThrow();
});

// Reproduced live during review: `close: [0]` returned `closeMinor: 0`,
// `close: [-5]` returned `closeMinor: -500`, both as if they were valid
// closes, before `requirePositiveMinor` existed. A zero/negative close is
// never real for a listed security and must fail loudly instead of
// flowing into the portfolio total.

test("rejects a zero close instead of returning it as a valid price", async () => {
  const zero = async (): Promise<Response> =>
    Response.json({
      chart: {
        result: [
          {
            meta: { currency: "EUR" },
            timestamp: [1735689600],
            indicators: { quote: [{ close: [0] }] },
          },
        ],
        error: null,
      },
    });
  await expect(
    YAHOO.fetch({ sourceKey: "X", from: "2025-01-01", to: "2025-01-02", fetchImpl: zero }),
  ).rejects.toThrow(/epäkelpo hinta/);
});

test("rejects a negative close instead of returning it as a valid price", async () => {
  const negative = async (): Promise<Response> =>
    Response.json({
      chart: {
        result: [
          {
            meta: { currency: "EUR" },
            timestamp: [1735689600],
            indicators: { quote: [{ close: [-5] }] },
          },
        ],
        error: null,
      },
    });
  await expect(
    YAHOO.fetch({ sourceKey: "X", from: "2025-01-01", to: "2025-01-02", fetchImpl: negative }),
  ).rejects.toThrow(/epäkelpo hinta/);
});

test("rejects a payload that does not match the expected schema", async () => {
  const garbage = async (): Promise<Response> => Response.json({ unexpected: true });
  await expect(
    YAHOO.fetch({ sourceKey: "X", from: "2025-01-01", to: "2025-01-02", fetchImpl: garbage }),
  ).rejects.toThrow();
});

test("surfaces a non-200 response as an error", async () => {
  const failing = async (): Promise<Response> => new Response("rate limited", { status: 429 });
  await expect(
    YAHOO.fetch({ sourceKey: "X", from: "2025-01-01", to: "2025-01-02", fetchImpl: failing }),
  ).rejects.toThrow(/429/);
});

test("a window with no trading in it yields no prices, not a failure", async () => {
  // Yahoo answers a Saturday, a holiday, or a fund that has not published yet
  // with meta alone. Requiring timestamp and close turned every weekend
  // refresh into two dozen logged failures, with any real one lost among them.
  // Yahoo's real shape for an empty window: `quote` present but with no
  // `close` inside it, which is not the same as `indicators` being absent.
  const empty = {
    chart: {
      result: [{ meta: { currency: "EUR" }, indicators: { quote: [{}], adjclose: [{}] } }],
    },
  };

  const points = await YAHOO.fetch({
    sourceKey: "0P00015EIP.F",
    from: "2026-08-29",
    to: "2026-08-29",
    fetchImpl: async () => new Response(JSON.stringify(empty), { status: 200 }),
  });

  expect(points).toEqual([]);
});

test("a window with bars still yields them", async () => {
  const payload = {
    chart: {
      result: [
        {
          meta: { currency: "EUR" },
          timestamp: [1787551200],
          indicators: { quote: [{ close: [24.04] }] },
        },
      ],
    },
  };

  const points = await YAHOO.fetch({
    sourceKey: "TEST.HE",
    from: "2026-05-22",
    to: "2026-05-22",
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
  });

  expect(points).toHaveLength(1);
  expect(points[0]?.closeMinor).toBe(2404);
});
